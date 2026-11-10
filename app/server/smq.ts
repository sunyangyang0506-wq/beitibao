import type { IncomingHttpHeaders } from 'node:http';
import { cloudCredentials } from './paper-storage.js';
import type { QueueEvent } from './job-outbox.js';

export type QueueMessage = { receipt: string; eventId: string | null };
export type WorkQueue = {
  publish(event: QueueEvent, delay?: number): Promise<void>;
  receive(): Promise<QueueMessage | null>;
  ack(receipt: string): Promise<void>;
};

function decodeQueueEvent(message: string) {
  if (message.length > 1024) return null;
  try {
    const event = JSON.parse(message);
    return event?.version === 1 && typeof event.eventId === 'string' &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(event.eventId) ? event.eventId as string : null;
  } catch {
    return null;
  }
}

export function readQueueCloudEvents(payload: unknown, account: string | undefined, queue: string | undefined) {
  if (!account || !queue) return null;
  const subject = `acs:mns:cn-beijing:${account}:queues/${queue}`;
  const events: unknown[] = Array.isArray(payload) ? payload : [payload];
  if (!events.length || events.length > 4) return null;
  const ids: string[] = [];
  for (const value of events) {
    const event = value as { subject?: unknown; type?: unknown; data?: { messageBody?: unknown } } | null;
    if (event?.subject !== subject || event.type !== 'mns:Queue:SendMessage' ||
        typeof event.data?.messageBody !== 'string') return null;
    const id = decodeQueueEvent(event.data.messageBody);
    if (!id) return null;
    ids.push(id);
  }
  return ids;
}

export async function beijingQueue(headers: IncomingHttpHeaders): Promise<WorkQueue> {
  const account = process.env.BEITIBAO_SMQ_ACCOUNT_ID;
  const queue = process.env.BEITIBAO_SMQ_QUEUE;
  if (!account || !/^[0-9]{16}$/.test(account) || !queue ||
      !/^beitibao-(staging|production)-[a-z0-9]{6,12}-(paper|page|solution|prediction|practice)$/.test(queue)) {
    throw new Error('SMQ_CONFIGURATION_REQUIRED');
  }
  // The SDK debug log can include signed request headers.
  delete process.env.DEBUG;
  const { default: MnsClient } = await import('@alicloud/mns');
  const { accessKeyId, accessKeySecret, stsToken } = cloudCredentials(headers);
  const endpointRegion = process.env.FC_REGION === 'cn-beijing' ? 'cn-beijing-internal' : 'cn-beijing';
  const client = new MnsClient(account, { endpoint: `https://${account}.mns.${endpointRegion}.aliyuncs.com`,
    accessKeyId, accessKeySecret, securityToken: stsToken, connectTimeout: 3000, readTimeout: 6000 });
  return {
    async publish(event, delay = 0) {
      const result = await client.sendMessage(queue, {
        MessageBody: Buffer.from(JSON.stringify(event)).toString('base64'), DelaySeconds: delay
      });
      if (result.code !== 201 || !result.body?.MessageId) throw new Error('SMQ_PUBLISH_REJECTED');
    },
    async receive() {
      const received = await client.receiveMessage(queue, 1).catch(error => {
        if (error instanceof Error && error.name.startsWith('MNSMessageNotExist')) return null;
        throw error;
      });
      if (!received) return null;
      const { MessageBody, ReceiptHandle } = received.body ?? {};
      if (!ReceiptHandle) throw new Error('SMQ_RECEIPT_REQUIRED');
      const eventId = MessageBody && MessageBody.length <= 1024 ?
        decodeQueueEvent(Buffer.from(MessageBody, 'base64').toString('utf8')) : null;
      return { eventId, receipt: ReceiptHandle };
    },
    async ack(receipt) {
      if ((await client.deleteMessage(queue, receipt)).code !== 204) throw new Error('SMQ_ACK_REJECTED');
    }
  };
}
