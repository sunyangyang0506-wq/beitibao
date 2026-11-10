import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import sharp from 'sharp';
import { createApp } from '../dist/server/app.js';
import { runBusinessBatch } from '../dist/server/release-jobs.js';
import { extractPages, renderPage } from '../dist/server/paper-parser.js';

const origin = 'https://127.0.0.1:5443';
const scratch = await mkdtemp(join(tmpdir(), 'beitibao-release-browser-'));
const { DATABASE_URL, MIGRATION_DATABASE_URL, LOCAL_PAPER_WORKER_DATABASE_URL } = process.env;
const pool = new pg.Pool({ connectionString: DATABASE_URL });
const admin = new pg.Pool({ connectionString: MIGRATION_DATABASE_URL });
const worker = new pg.Pool({ connectionString: LOCAL_PAPER_WORKER_DATABASE_URL });
const permits = new Map();
const objects = new Map();
const storage = {
  signUpload(key, mediaType, bytes) {
    const permit = randomUUID();
    permits.set(permit, { key, mediaType, bytes });
    return { url: origin + '/test-oss', fields: { permit } };
  },
  async read(object) {
    const stored = objects.get(object.key);
    return stored?.version === object.version ? stored.bytes : null;
  }
};
const settings = { storage, modelsEnabled: false, predictionsEnabled: false };
const app = await createApp({ pool, origin, privatePapers: { ...settings, storage: () => storage },
  webRoot: fileURLToPath(new URL('../../pc-prototype/dist/connected/', import.meta.url)) });
let secure;
try {
  const email = 'release-browser@example.test';
  const invite = randomBytes(32).toString('base64url');
  await admin.query("INSERT INTO invitations (email, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [email, createHash('sha256').update(invite).digest('hex')]);
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', join(scratch, 'key.pem'), '-out', join(scratch, 'cert.pem')]);
  await sharp({ create: { width: 320, height: 240, channels: 3, background: '#f33' } }).jpeg().toFile(join(scratch, 'first.jpg'));
  await sharp({ create: { width: 320, height: 240, channels: 3, background: '#393' } }).png().toFile(join(scratch, 'second.png'));
  const upstream = await app.listen({ host: '127.0.0.1', port: 0 });
  secure = createServer({ key: await readFile(join(scratch, 'key.pem')), cert: await readFile(join(scratch, 'cert.pem')) },
    async (incoming, outgoing) => {
      if (incoming.method === 'POST' && incoming.url === '/test-oss') {
        try {
          const form = await new Request(origin + incoming.url, { method: 'POST', headers: incoming.headers,
            body: Readable.toWeb(incoming), duplex: 'half' }).formData();
          const permit = permits.get(form.get('permit'));
          const file = form.get('file');
          if (!permit || typeof file === 'string' || file?.type !== permit.mediaType || file.size !== permit.bytes) {
            outgoing.writeHead(400).end();
            return;
          }
          const bytes = Buffer.from(await file.arrayBuffer());
          if (file.type === 'application/pdf') {
            const pages = await extractPages(bytes);
            const colors = [];
            for (let page = 1; page <= pages.length; page++) {
              const image = await renderPage(bytes, page, 320);
              const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
              const center = ((info.height >> 1) * info.width + (info.width >> 1)) * info.channels;
              colors.push([...data.subarray(center, center + 3)]);
            }
            console.log(JSON.stringify({ pages: pages.length, centerPixels: colors }));
          }
          const version = randomUUID();
          objects.set(permit.key, { bytes, version });
          outgoing.writeHead(201, { 'x-oss-version-id': version }).end();
        } catch {
          outgoing.writeHead(400).end();
        }
        return;
      }
      const proxy = request(upstream + incoming.url, { method: incoming.method, headers: incoming.headers }, response => {
        outgoing.writeHead(response.statusCode, response.headers);
        response.pipe(outgoing);
      });
      proxy.on('error', () => outgoing.writeHead(502).end());
      incoming.pipe(proxy);
    });
  await new Promise((resolve, reject) => secure.once('error', reject).listen(5443, '127.0.0.1', resolve));
  console.log('HTTPS test fixtures:', scratch);
  console.log('Synthetic invitation:', invite);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; });
  while (!stopping) {
    await runBusinessBatch(worker, 'paper', null, settings);
    await delay(250);
  }
} finally {
  if (secure) await new Promise(resolve => secure.close(resolve));
  await app.close();
  await Promise.all([pool.end(), admin.end(), worker.end(), rm(scratch, { recursive: true, force: true })]);
}
