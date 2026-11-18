import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { startPostgres } from './pg';
import { migrate } from './migrate';

/**
 * Environnement de recette : Postgres jetable, worker, et l'app compilée (`next start`).
 * Lancé par Playwright (voir playwright.config.ts). Données dans .data/e2e, effacées à chaque lancement.
 */
const root = path.resolve('.data/e2e');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
const pg = await startPostgres({ dir: path.join(root, 'pg'), port: 54410, persistent: false });
await migrate(pg.url, () => {});

Object.assign(process.env, {
  DATABASE_URL: pg.url,
  APP_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e-secret',
  APP_URL: 'http://localhost:3100',
  STORAGE_DIR: path.join(root, 'storage'),
  MAIL_DIR: path.join(root, 'mail'),
  ALLOW_LOCAL_DRIVERS: '1',
});

const next = spawn('npx', ['next', 'start', '-p', '3100'], { stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } });

const { drain } = await import('../worker/index');
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  next.kill('SIGTERM');
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
next.on('exit', stop);
while (!stopping) {
  const n = await drain((m) => console.log(`[worker] ${m}`)).catch((e) => { console.error(e); return 0; });
  if (n === 0) await new Promise((r) => setTimeout(r, 500));
}
