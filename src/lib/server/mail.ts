import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from './env';

export type Mail = {
  to: string; subject: string; text: string; html?: string; tag?: string;
  /** Nom d'expéditeur affiché (l'adresse reste celle de MAIL_FROM). */
  fromName?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  /** Clé d'idempotence : un nouvel essai avec la même clé n'envoie pas deux fois (Resend). */
  idempotencyKey?: string;
};

const fromWithName = (from: string, name?: string) => {
  if (!name) return from;
  const addr = /<([^>]+)>/.exec(from)?.[1] ?? from;
  return `${name.replace(/["<>\r\n]/g, '').slice(0, 60)} <${addr}>`;
};

export class MailError extends Error {}

/**
 * Envoi d'email.
 * - Pilote « local » (développement, tests) : un fichier JSON par email dans MAIL_DIR, rien ne part.
 * - Pilote « resend » (mise en ligne) : API Resend. Sans domaine vérifié, Resend n'envoie qu'à l'adresse du compte.
 */
export async function sendMail(mail: Mail, opts: { fetch?: typeof fetch } = {}) {
  const e = env();
  if (e.MAIL_DRIVER === 'resend') {
    const res = await (opts.fetch ?? fetch)('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${e.RESEND_API_KEY}`, 'content-type': 'application/json',
        ...(mail.idempotencyKey ? { 'idempotency-key': mail.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: fromWithName(e.MAIL_FROM, mail.fromName), to: [mail.to], subject: mail.subject, text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
        ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
        ...(mail.headers ? { headers: mail.headers } : {}),
        ...(mail.tag ? { tags: [{ name: 'category', value: mail.tag }] } : {}),
      }),
    });
    if (!res.ok) throw new MailError(`Resend a refusé l’email (HTTP ${res.status}) : ${(await res.text()).slice(0, 200)}`);
    return;
  }
  const dir = path.resolve(e.MAIL_DIR);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  await writeFile(file, JSON.stringify({ ...mail, from: fromWithName(e.MAIL_FROM, mail.fromName), sentAt: new Date().toISOString() }, null, 2));
  if (e.NODE_ENV === 'development') console.log(`[mail] ${mail.to} — ${mail.subject}`);
}
