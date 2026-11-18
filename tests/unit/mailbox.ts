import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Dernier code envoyé à `email` (pilote email local). */
export async function lastCodeFor(email: string): Promise<string> {
  const dir = process.env.MAIL_DIR!;
  const files = (await readdir(dir)).sort().reverse();
  for (const f of files) {
    const m = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
    if (m.to === email.toLowerCase() && m.tag === 'login_code') return /(\d{6})/.exec(m.subject)![1];
  }
  throw new Error(`aucun code pour ${email}`);
}
