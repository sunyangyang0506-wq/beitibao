declare module '@alicloud/mns' {
  type Result = { code: number; body?: { MessageId?: string; MessageBody?: string; ReceiptHandle?: string } };
  export default class MnsClient {
    constructor(account: string, options: { endpoint: string; accessKeyId: string; accessKeySecret: string;
      securityToken: string; connectTimeout: number; readTimeout: number });
    sendMessage(queue: string, options: { MessageBody: string; DelaySeconds: number }): Promise<Result>;
    receiveMessage(queue: string, waitSeconds: number): Promise<Result>;
    deleteMessage(queue: string, receipt: string): Promise<Result>;
  }
}
