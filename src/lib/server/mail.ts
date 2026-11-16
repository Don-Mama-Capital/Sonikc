import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from './env';

export type Mail = { to: string; subject: string; text: string; html?: string; tag?: string };

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
      headers: { authorization: `Bearer ${e.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: e.MAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
        ...(mail.tag ? { tags: [{ name: 'category', value: mail.tag }] } : {}),
      }),
    });
    if (!res.ok) throw new MailError(`Resend a refusé l’email (HTTP ${res.status}) : ${(await res.text()).slice(0, 200)}`);
    return;
  }
  const dir = path.resolve(e.MAIL_DIR);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  await writeFile(file, JSON.stringify({ ...mail, sentAt: new Date().toISOString() }, null, 2));
  if (e.NODE_ENV === 'development') console.log(`[mail] ${mail.to} — ${mail.subject}`);
}
