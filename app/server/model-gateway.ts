import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { asTenant } from './db.js';

type Task = 'paper' | 'page' | 'solution' | 'prediction' | 'figure';
type Rate = { input: number; output: number; maxInput: number };
// CNY per million tokens is numerically equal to micro-CNY per token.
// Beijing realtime list prices; Plus thinking output includes reasoning + answer.
// Verified 2026-11-10: https://help.aliyun.com/zh/model-studio/qwen-plus
const rates = new Map<string, Rate & { thinkingOutput?: number }>([
  ['qwen-flash-2025-07-28', { input: 0.15, output: 1.5, maxInput: 32_000 }],
  ['qwen-plus-2025-12-01', { input: 0.8, output: 2, thinkingOutput: 8, maxInput: 32_000 }],
  ['qwen3.5-flash-2026-02-23', { input: 0.2, output: 2, maxInput: 32_000 }],
  ['qwen3-vl-plus', { input: 1, output: 10, maxInput: 32_000 }]
]);

type Quota = { rpm: number; tpm: number };
function modelQuotas(value = process.env.BAILIAN_MODEL_LIMITS_JSON): Record<string, Quota> | null {
  if (!value) return null;
  const quota = JSON.parse(value) as Record<string, Quota> | null;
  if (!quota || Object.keys(quota).length !== rates.size || [...rates.keys()].some(model => {
    const limit = quota[model];
    return !limit || !Number.isSafeInteger(limit.rpm) || limit.rpm < 1 ||
      !Number.isSafeInteger(limit.tpm) || limit.tpm < 1;
  })) throw new Error('INVALID_BAILIAN_MODEL_LIMITS');
  return quota;
}

export function validateModelReleaseConfiguration() {
  if (!/^[a-zA-Z0-9-]+$/.test(process.env.BAILIAN_WORKSPACE_ID ?? '') ||
      !process.env.DASHSCOPE_API_KEY || !modelQuotas()) throw new Error('MODEL_RELEASE_CONFIGURATION_REQUIRED');
}

function budgetMicros(name: string) {
  const cents = Number(process.env[name] ?? '100');
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > 100_000_000) throw new Error('INVALID_MODEL_BUDGET');
  return cents * 10_000;
}

function estimate(rate: Rate, input: number, output: number) {
  return Math.ceil(input * rate.input + output * rate.output);
}

async function reserve(pool: Pool, tenant: string, task: Task, model: string, held: number, tokenCeiling: number) {
  const id = randomUUID();
  const siteLimit = budgetMicros('BAILIAN_DAILY_BUDGET_CENTS');
  const tenantLimit = budgetMicros('BAILIAN_TENANT_DAILY_BUDGET_CENTS');
  const allowance = task === 'prediction' ? Math.floor(siteLimit * 0.85) : siteLimit;
  const quota = modelQuotas()?.[model];
  const reservation = await asTenant(pool, tenant, async db => {
    if (quota) {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 90814))', [model]);
      await db.query("DELETE FROM model_rate_events WHERE model = $1 AND started_at <= clock_timestamp() - interval '60 seconds'", [model]);
      const { rows: [window] } = await db.query<{ requests: number; tokens: string }>(`
        SELECT count(*)::int AS requests, coalesce(sum(tokens_reserved), 0)::text AS tokens
        FROM model_rate_events WHERE model = $1
      `, [model]);
      if (window!.requests >= quota.rpm || Number(window!.tokens) + tokenCeiling > quota.tpm) throw new Error('MODEL_RATE_LIMIT');
      await db.query('INSERT INTO model_rate_events (id, model, tokens_reserved) VALUES ($1, $2, $3)', [id, model, tokenCeiling]);
    }
    const { rows: [clock] } = await db.query<{ day: string }>(
      "SELECT ((now() AT TIME ZONE 'Asia/Shanghai')::date)::text AS day");
    const day = clock!.day;
    await db.query('INSERT INTO model_budget_days (day) VALUES ($1) ON CONFLICT DO NOTHING', [day]);
    await db.query('INSERT INTO model_tenant_days (tenant_id, day) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tenant, day]);
    const { rows: [site] } = await db.query<{ warned: boolean; used: string }>(`
      UPDATE model_budget_days SET held_micros = held_micros + $2
      WHERE day = $1 AND held_micros + spent_micros + $2 <= $3
      RETURNING warned, (held_micros + spent_micros)::text AS used
    `, [day, held, allowance]);
    if (!site) throw new Error('MODEL_BUDGET_LIMIT');
    const owner = await db.query(`
      UPDATE model_tenant_days SET held_micros = held_micros + $3
      WHERE tenant_id = $1 AND day = $2 AND held_micros + spent_micros + $3 <= $4
    `, [tenant, day, held, tenantLimit]);
    if (!owner.rowCount) throw new Error('MODEL_BUDGET_LIMIT');
    await db.query(`
      INSERT INTO model_invocations (tenant_id, id, day, task, model, held_micros)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [tenant, id, day, task, model, held]);
    const warn = !site.warned && Number(site.used) >= siteLimit * 0.7;
    if (warn) await db.query('UPDATE model_budget_days SET warned = true WHERE day = $1', [day]);
    return { day, warn };
  });
  if (reservation.warn) console.warn(JSON.stringify({ code: 'MODEL_BUDGET_WARNING', day: reservation.day }));
  return id;
}

type Usage = {
  state: 'metered' | 'rejected' | 'unknown'; spent: number;
  input?: number; output?: number; requestId?: string; status?: number;
};

async function settle(pool: Pool, tenant: string, id: string, usage: Usage) {
  await asTenant(pool, tenant, async db => {
    const { rows: [invocation] } = await db.query<{ day: string; held: string }>(`
      UPDATE model_invocations SET state = $3, spent_micros = $4,
        input_tokens = $5, output_tokens = $6, request_id = $7, http_status = $8, finished_at = now()
      WHERE tenant_id = $1 AND id = $2 AND state = 'reserved'
      RETURNING day::text, held_micros::text AS held
    `, [tenant, id, usage.state, usage.spent, usage.input, usage.output, usage.requestId, usage.status]);
    if (!invocation || usage.state === 'unknown') return;
    await db.query(`
      UPDATE model_budget_days SET held_micros = held_micros - $2, spent_micros = spent_micros + $3 WHERE day = $1
    `, [invocation.day, invocation.held, usage.spent]);
    await db.query(`
      UPDATE model_tenant_days SET held_micros = held_micros - $3, spent_micros = spent_micros + $4
      WHERE tenant_id = $1 AND day = $2
    `, [tenant, invocation.day, invocation.held, usage.spent]);
  });
}

async function usageOf(response: Response, rate: Rate): Promise<Usage> {
  const body = await response.clone().json().catch(() => null);
  const requestId = body?.request_id ?? body?.id;
  const input = body?.usage?.prompt_tokens;
  const output = body?.usage?.completion_tokens;
  const fields = { status: response.status,
    ...(typeof requestId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId) ? { requestId } : {}) };
  if (Number.isSafeInteger(input) && input >= 0 && input <= 2_000_000 &&
      Number.isSafeInteger(output) && output >= 0 && output <= 2_000_000) {
    // If a provider exceeds the reserved input tier, retain the reservation for reconciliation.
    if (input > rate.maxInput) return { ...fields, state: 'unknown', spent: 0, input, output };
    // completion_tokens already includes reasoning_tokens; never add the detail again.
    return { ...fields, state: 'metered', spent: estimate(rate, input, output), input, output };
  }
  // A 402 status alone does not prove zero usage. Only an explicit pre-call
  // billing rejection with no usage field can release the reservation. Partial,
  // malformed or oversized usage must remain held for billing reconciliation.
  if (response.status === 402) {
    const object = body !== null && typeof body === 'object' && !Array.isArray(body);
    const code = object ? body.error?.code ?? body.code : null;
    const rejectedBeforeProcessing = object && !Object.hasOwn(body, 'usage') &&
      ['Arrearage', 'ServiceInDebt', 'AccessDenied.Arrearage', 'InsufficientBalance'].includes(code);
    return { ...fields, state: rejectedBeforeProcessing ? 'rejected' : 'unknown', spent: 0 };
  }
  return { ...fields, state: [400, 401, 403, 404, 429].includes(response.status) ? 'rejected' : 'unknown', spent: 0 };
}

export function modelRequest(pool: Pool, tenant: string, task: Task, request = fetch): typeof fetch {
  return async (input, options) => {
    const target = new URL(input instanceof Request ? input.url : input);
    const workspace = process.env.BAILIAN_WORKSPACE_ID;
    if (!workspace || !/^[a-zA-Z0-9-]+$/.test(workspace) ||
        target.href !== `https://${workspace}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions` ||
        options?.method !== 'POST' || typeof options.body !== 'string') throw new Error('INVALID_MODEL_REQUEST');
    const body = JSON.parse(options.body);
    const modelRate = rates.get(body.model);
    if (!modelRate || body.stream === true || !Number.isSafeInteger(body.max_tokens) ||
        (body.enable_thinking !== undefined && typeof body.enable_thinking !== 'boolean') ||
        body.max_tokens < 1 || body.max_tokens > 8192) throw new Error('INVALID_MODEL_REQUEST');
    const thinking = body.enable_thinking === true ? body.thinking_budget : 0;
    if (!Number.isSafeInteger(thinking) || thinking < 0 || thinking > 2048 || (body.enable_thinking === true && !thinking)) {
      throw new Error('INVALID_MODEL_REQUEST');
    }
    // Select once so reservation and settlement use the same request mode.
    // Plus defaults to non-thinking when enable_thinking is omitted.
    const rate: Rate = { ...modelRate,
      output: body.enable_thinking === true ? modelRate.thinkingOutput ?? modelRate.output : modelRate.output };
    const invocation = await reserve(pool, tenant, task, body.model, estimate(rate, rate.maxInput, body.max_tokens + thinking),
      rate.maxInput + body.max_tokens + thinking);
    let usage: Usage = { state: 'unknown', spent: 0 };
    try {
      const response = await request(input, options);
      usage = await usageOf(response, rate);
      return response;
    } finally {
      await settle(pool, tenant, invocation, usage).catch(() => {
        // The durable reservation remains held and can be reconciled later.
        console.error(JSON.stringify({ code: 'MODEL_USAGE_RECONCILIATION_REQUIRED', invocation }));
      });
    }
  };
}
