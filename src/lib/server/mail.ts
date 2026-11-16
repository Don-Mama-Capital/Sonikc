import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from './env';

export type Mail = { to: string; subject: string; text: string; html?: string; tag?: string };

/**
 * Envoi d'email. En développement et en test, le message est écrit dans MAIL_DIR
 * (un fichier JSON par email) : aucun email réel ne part. Le pilote Resend arrivera
 * avec la mise en ligne.
 */
export async function sendMail(mail: Mail) {
  const dir = path.resolve(env().MAIL_DIR);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  await writeFile(file, JSON.stringify({ ...mail, sentAt: new Date().toISOString() }, null, 2));
  if (env().NODE_ENV === 'development') console.log(`[mail] ${mail.to} — ${mail.subject}`);
}
