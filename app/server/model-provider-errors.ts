// Stable, non-sensitive codes only: never persist provider messages or credentials.
export function modelProviderFailure(status: number, body: unknown): string | null {
  if (status >= 200 && status < 300) return null;
  const data = body as { code?: unknown; error?: { code?: unknown } } | null;
  const raw = data?.error?.code ?? data?.code;
  const code = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (status === 402 || ['arrearage', 'serviceindebt', 'accessdenied.arrearage', 'insufficientbalance'].includes(code)) return 'MODEL_PAYMENT_REQUIRED';
  if (code === 'accessdenied.unpurchased') return 'MODEL_SERVICE_NOT_ENABLED';
  if (status === 401) return 'MODEL_AUTHENTICATION_FAILED';
  if (status === 403) return 'MODEL_ACCESS_DENIED';
  return null;
}

export function isTerminalModelFailure(code: string): boolean {
  return ['MODEL_BUDGET_LIMIT', 'MODEL_NOT_CONFIGURED', 'MODEL_PAYMENT_REQUIRED',
    'MODEL_SERVICE_NOT_ENABLED', 'MODEL_AUTHENTICATION_FAILED', 'MODEL_ACCESS_DENIED'].includes(code);
}
