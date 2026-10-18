/**
 * Outgoing sign-in email. Provider-neutral: MAIL_MODE=webhook POSTs {from,to,subject,text} as JSON to MAIL_WEBHOOK_URL
 * (point it at your mail service or a small relay) with an HMAC signature header; MAIL_MODE=log prints the message for
 * local development only (refused in production); MAIL_MODE=off sends nothing, so nobody can sign in.
 */
import { createHmac } from 'node:crypto';
import type { GatewayConfig } from './config.ts';
import type { MailSender } from './auth.ts';

export function createMailSender(config: GatewayConfig, doFetch: typeof fetch = globalThis.fetch, log: (line: string) => void = line => console.log(line)): MailSender {
  return async message => {
    if (config.mail.mode === 'off') return;
    if (config.mail.mode === 'log') { log('[dev mail] to=' + message.to + ' subject=' + JSON.stringify(message.subject) + '\n' + message.text); return; }
    const body = JSON.stringify({ from: config.mail.from, ...message });
    const signature = config.mail.webhookSecret ? createHmac('sha256', config.mail.webhookSecret).update(body).digest('hex') : '';
    const response = await doFetch(config.mail.webhookUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', ...(signature ? { 'X-Arcane-Signature': 'sha256=' + signature } : {}) }, body });
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new Error('Mail relay refused the message (' + response.status + ').');
  };
}
