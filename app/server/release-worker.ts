import Fastify from 'fastify';
import pg from 'pg';
import { businessLanes, type BusinessLane } from './job-outbox.js';
import { runBusinessBatch, runBusinessEvent, runPracticeBatch } from './release-jobs.js';
import { ossPaperStorage } from './paper-storage.js';
import { beijingQueue, readQueueCloudEvents } from './smq.js';
import { consumePracticeDeadline } from './practice.js';
import { runMaintenance } from './maintenance.js';
import { processNextPasswordRecovery, recoverySecret } from './password-recovery.js';
import { recoveryMailer } from './recovery-mail.js';
import { validateModelReleaseConfiguration } from './model-gateway.js';

const { BEITIBAO_JOB_KIND: lane, BEITIBAO_JOB_DATABASE_URL: connectionString,
  BEITIBAO_PRIVATE_PAPER_BUCKET: bucket } = process.env;
if (!lane || !connectionString || !['practice', 'mail', 'maintenance', ...businessLanes].includes(lane) ||
    (!['practice', 'mail'].includes(lane) && !bucket)) throw new Error('RELEASE_JOB_CONFIGURATION_REQUIRED');
if (bucket) ossPaperStorage(bucket);
const modelsEnabled = process.env.BEITIBAO_ENABLE_MODELS === '1';
if (modelsEnabled && businessLanes.includes(lane as BusinessLane)) validateModelReleaseConfiguration();
const predictionsEnabled = modelsEnabled && process.env.BEITIBAO_ENABLE_PREDICTIONS === '1';
const pushDelivery = process.env.BEITIBAO_SMQ_PUSH === '1';
const secret = lane === 'mail' ? recoverySecret() : null;
if (lane === 'mail' && !secret) throw new Error('RECOVERY_CONFIGURATION_REQUIRED');
const mail = lane === 'mail' ? recoveryMailer() : null;
const pool = new pg.Pool({ connectionString, max: 2, idleTimeoutMillis: 1000, connectionTimeoutMillis: 3000 });
const app = Fastify({ bodyLimit: 16 * 1024 });
app.addContentTypeParser('application/octet-stream', { parseAs: 'string' }, (_request, body, done) => done(null, body));
app.addHook('onClose', async () => { mail?.close(); await pool.end(); });
app.get('/healthz', async () => ({ status: 'ok' }));
let busy = false;
app.post('/invoke', async (request, reply) => {
  let event;
  try { event = typeof request.body === 'string' ? JSON.parse(request.body) : request.body; } catch { event = null; }
  const timer = event && typeof event === 'object' && 'triggerName' in event && event.triggerName === 'schedule' &&
    'payload' in event && event.payload === `beitibao:${lane}`;
  const deliveries = !timer && pushDelivery && lane !== 'mail' && lane !== 'maintenance' ?
    readQueueCloudEvents(event, process.env.BEITIBAO_SMQ_ACCOUNT_ID, process.env.BEITIBAO_SMQ_QUEUE) : null;
  if (process.env.FC_REGION !== 'cn-beijing' || typeof request.headers['x-fc-request-id'] !== 'string' || (!timer && !deliveries)) {
    return reply.header('x-fc-status', '404').code(400).send({ code: 'INVALID_JOB_EVENT' });
  }
  if (busy) return reply.header('x-fc-status', '404').code(503).send({ code: 'WORKER_BUSY' });
  busy = true;
  const started = Date.now();
  try {
    let result;
    if (deliveries) {
      const work = lane === 'practice' ? (eventId: string) => consumePracticeDeadline(pool, eventId)
        : (eventId: string) => runBusinessEvent(pool, lane as BusinessLane, eventId,
          { storage: ossPaperStorage(bucket!, request.headers), modelsEnabled, predictionsEnabled });
      for (const eventId of deliveries) if (!await work(eventId)) throw new Error('WORK_NOT_TERMINAL');
      result = { acknowledged: deliveries.length };
    } else if (lane === 'maintenance') {
      const storage = ossPaperStorage(bucket!, request.headers);
      result = await runMaintenance(pool, (key, version) => storage.purge(key, version));
    } else if (lane === 'mail') {
      let processed = 0;
      while (processed < 10 && Date.now() - started < 20_000 &&
        await processNextPasswordRecovery(pool, secret!, mail!.origin, mail!.send)) processed++;
      result = { processed };
    } else {
      const queue = await beijingQueue(request.headers).catch(() => {
        console.warn(JSON.stringify({ code: 'SMQ_CONFIGURATION_UNAVAILABLE', lane }));
        return null;
      });
      result = lane === 'practice' ? await runPracticeBatch(pool, queue, pushDelivery) : await runBusinessBatch(pool, lane as BusinessLane,
        queue, { storage: ossPaperStorage(bucket!, request.headers), modelsEnabled, predictionsEnabled }, pushDelivery);
    }
    console.log(JSON.stringify({ code: 'WORKER_BATCH', lane, elapsedMs: Date.now() - started, ...result }));
    return { status: 'ok', ...result };
  } catch {
    console.error(JSON.stringify({ code: 'WORKER_BATCH_FAILED', lane, elapsedMs: Date.now() - started }));
    return reply.header('x-fc-status', '404').code(503).send({ code: 'WORKER_BATCH_FAILED' });
  } finally {
    busy = false;
  }
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void app.close());
await app.listen({ host: '0.0.0.0', port: Number(process.env.FC_CUSTOM_LISTEN_PORT ?? process.env.PORT ?? 9000) });
