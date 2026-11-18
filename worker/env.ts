import { existsSync, readFileSync } from 'node:fs';

/** Charge .env pour le worker (Next.js le fait déjà pour l'app). Les variables déjà définies gagnent. */
export function config(file = '.env') {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
