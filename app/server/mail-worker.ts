import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { processNextPasswordRecovery, recoverySecret } from './password-recovery.js';
import { recoveryMailer } from './recovery-mail.js';

const { RECOVERY_DATABASE_URL } = process.env;
const secret = recoverySecret();
if (!RECOVERY_DATABASE_URL || !secret) {
  throw new Error('RECOVERY_CONFIGURATION_REQUIRED');
}
const mail = recoveryMailer();
const pool = new pg.Pool({ connectionString: RECOVERY_DATABASE_URL, max: 1, connectionTimeoutMillis: 3000 });
let running = true;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { running = false; });
try {
  while (running) {
    try {
      const processed = await processNextPasswordRecovery(pool, secret, mail.origin, mail.send);
      if (!processed) await delay(2000);
    } catch {
      console.error(JSON.stringify({ code: 'RECOVERY_WORKER_ERROR' }));
      await delay(5000);
    }
  }
} finally {
  mail.close();
  await pool.end();
}
