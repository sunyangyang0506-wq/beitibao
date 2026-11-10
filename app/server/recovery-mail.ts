import nodemailer from 'nodemailer';

export function recoveryMailer(env = process.env) {
  const { RECOVERY_SMTP_URL, RECOVERY_MAIL_FROM, WEB_ORIGIN } = env;
  if (!RECOVERY_SMTP_URL || !RECOVERY_MAIL_FROM || !WEB_ORIGIN) throw new Error('RECOVERY_CONFIGURATION_REQUIRED');
  const smtp = new URL(RECOVERY_SMTP_URL);
  const origin = new URL(WEB_ORIGIN);
  if (smtp.protocol !== 'smtps:' || origin.origin !== WEB_ORIGIN || origin.protocol !== 'https:' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(RECOVERY_MAIL_FROM)) throw new Error('INVALID_RECOVERY_CONFIGURATION');
  const transport = nodemailer.createTransport({
    host: smtp.hostname, port: Number(smtp.port || 465), secure: true,
    auth: { user: decodeURIComponent(smtp.username), pass: decodeURIComponent(smtp.password) },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000
  });
  return {
    origin: origin.origin,
    async send(to: string, link: string, id: string) {
      const result = await transport.sendMail({ from: RECOVERY_MAIL_FROM, to, subject: '背题宝密码重设',
        messageId: `<${id}@${origin.hostname}>`,
        text: `请在 20 分钟内打开以下链接重设背题宝密码。\n\n${link}\n\n如果你没有发起请求，可以忽略这封邮件。`
      });
      if (!result.accepted.length) throw new Error('RECOVERY_MAIL_REJECTED');
    },
    close: () => transport.close()
  };
}
