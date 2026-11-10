import pg from 'pg';
import { isIP } from 'node:net';
import { createApp } from './app.js';
import { ossPaperStorage } from './paper-storage.js';
import { validateModelReleaseConfiguration } from './model-gateway.js';

const { DATABASE_URL, WEB_ORIGIN, PORT, HOST, LOCAL_DEVELOPMENT } = process.env;
if (!DATABASE_URL || !WEB_ORIGIN) throw new Error('DATABASE_URL and WEB_ORIGIN are required');
const local = LOCAL_DEVELOPMENT === '1';
const bucket = process.env.BEITIBAO_PRIVATE_PAPER_BUCKET;
const modelsEnabled = process.env.BEITIBAO_ENABLE_MODELS === '1';
if (!local && modelsEnabled) validateModelReleaseConfiguration();
if (!local && !bucket) throw new Error('BEITIBAO_PRIVATE_PAPER_BUCKET is required');
if (!local && bucket) ossPaperStorage(bucket);
const trustedProxies = (process.env.TRUSTED_PROXY_CIDRS ?? '').split(',').map(item => item.trim()).filter(Boolean);
if (trustedProxies.some(item => {
  const [address, prefix, extra] = item.split('/');
  const family = isIP(address!);
  return !family || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) ||
    Number(prefix) < 1 || Number(prefix) > (family === 4 ? 32 : 128)));
})) throw new Error('TRUSTED_PROXY_CIDRS must contain explicit IP addresses or CIDRs');
const origin = new URL(WEB_ORIGIN);
if (origin.origin !== WEB_ORIGIN || (local
  ? origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname)
  : origin.protocol !== 'https:')) {
  throw new Error('WEB_ORIGIN must be an HTTPS origin or a loopback development origin');
}
const pool = new pg.Pool({
  connectionString: DATABASE_URL, max: 4, idleTimeoutMillis: 1000, connectionTimeoutMillis: 3000
});
const app = await createApp({ pool, origin: WEB_ORIGIN, secureCookies: !local, exposeOpenApi: local,
  accountAdminEmail: process.env.ACCOUNT_ADMIN_EMAIL?.trim().toLowerCase(), trustedProxies, localPapers: local && process.env.LOCAL_PAPERS === '1',
  localModelPreview: local && modelsEnabled, pdfOnlyUploads: true,
  webRoot: process.env.BEITIBAO_WEB_ROOT,
  privatePapers: !local && bucket ? {
    storage: headers => ossPaperStorage(bucket, headers),
    modelsEnabled,
    predictionsEnabled: modelsEnabled && process.env.BEITIBAO_ENABLE_PREDICTIONS === '1'
  } : undefined });
app.addHook('onClose', async () => pool.end());
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void app.close());
await app.listen({ port: Number(PORT ?? 3000), host: local ? '127.0.0.1' : HOST ?? '0.0.0.0' });
