import pg from 'pg';
import { dispatchPracticeDeadline } from '../dist/server/practice-deadline.js';
import { consumePracticeDeadline, settleExpiredPractices } from '../dist/server/practice.js';

const { PRACTICE_QUEUE_DATABASE_URL, BEITIBAO_SMQ_ACCOUNT_ID, BEITIBAO_SMQ_PRACTICE_QUEUE,
  ALIBABA_CLOUD_ACCESS_KEY_ID, ALIBABA_CLOUD_ACCESS_KEY_SECRET, ALIBABA_CLOUD_SECURITY_TOKEN } = process.env;
const mode = process.argv[2];
if (!['publish', 'consume', 'repair'].includes(mode) || !PRACTICE_QUEUE_DATABASE_URL) {
  throw new Error('PRACTICE_QUEUE_CONFIGURATION_REQUIRED');
}
if (mode !== 'repair' && (!/^[0-9]{16}$/.test(BEITIBAO_SMQ_ACCOUNT_ID ?? '') ||
    !/^beitibao-(staging|production)-[a-z0-9]{6,12}-practice$/.test(BEITIBAO_SMQ_PRACTICE_QUEUE ?? '') ||
    !ALIBABA_CLOUD_ACCESS_KEY_ID || !ALIBABA_CLOUD_ACCESS_KEY_SECRET || !ALIBABA_CLOUD_SECURITY_TOKEN)) {
  throw new Error('PRACTICE_QUEUE_STS_REQUIRED');
}
const pool = new pg.Pool({ connectionString: PRACTICE_QUEUE_DATABASE_URL, max: 1, connectionTimeoutMillis: 3000 });
try {
  if (mode === 'repair') await settleExpiredPractices(pool);
  else {
    // The SDK's debug namespace includes request headers and should remain disabled.
    delete process.env.DEBUG;
    const { default: MNSClient } = await import('@alicloud/mns');
    const queue = BEITIBAO_SMQ_PRACTICE_QUEUE;
    const client = new MNSClient(BEITIBAO_SMQ_ACCOUNT_ID, {
      endpoint: `https://${BEITIBAO_SMQ_ACCOUNT_ID}.mns.cn-beijing.aliyuncs.com`,
      accessKeyId: ALIBABA_CLOUD_ACCESS_KEY_ID, accessKeySecret: ALIBABA_CLOUD_ACCESS_KEY_SECRET,
      securityToken: ALIBABA_CLOUD_SECURITY_TOKEN, connectTimeout: 5000, readTimeout: 15_000
    });
    for (let i = 0; i < 20; i++) {
      if (mode === 'publish') {
        const sent = await dispatchPracticeDeadline(pool, async (event, delay) => {
          const result = await client.sendMessage(queue, {
            MessageBody: Buffer.from(JSON.stringify(event)).toString('base64'), DelaySeconds: delay
          });
          if (result.code !== 201 || typeof result.body?.MessageId !== 'string') throw new Error('SMQ_PUBLISH_REJECTED');
        });
        if (!sent) break;
      } else {
        const received = await client.receiveMessage(queue, 1).catch(error => {
          if (error instanceof Error && error.name.startsWith('MNSMessageNotExist')) return null;
          throw error;
        });
        if (!received) break;
        const { MessageBody, ReceiptHandle } = received.body ?? {};
        const event = typeof MessageBody === 'string' && MessageBody.length <= 1024
          ? JSON.parse(Buffer.from(MessageBody, 'base64').toString('utf8')) : null;
        if (event?.version !== 1 || typeof event.eventId !== 'string' ||
            !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(event.eventId) || typeof ReceiptHandle !== 'string') {
          throw new Error('INVALID_PRACTICE_EVENT');
        }
        if (await consumePracticeDeadline(pool, event.eventId)) {
          const deleted = await client.deleteMessage(queue, ReceiptHandle);
          if (deleted.code !== 204) throw new Error('SMQ_ACK_REJECTED');
        }
      }
    }
  }
} catch {
  console.error(JSON.stringify({ code: 'PRACTICE_QUEUE_WORKER_FAILED', mode }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
