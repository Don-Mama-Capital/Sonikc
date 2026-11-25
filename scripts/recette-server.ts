import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { startPostgres } from './pg';
import { migrate } from './migrate';
import { startFakeGoogle } from './fake-google';
import { startFakeStripe } from './fake-stripe';

/**
 * Environnement de recette (docs/recette.md). Lancé par Playwright (playwright.recette.config.ts).
 *
 * RECETTE_ENV=local (défaut) — niveau A : Postgres jetable, stockage local, faux Stripe et faux Google.
 * RECETTE_ENV=reel          — niveau B : base et stockage Supabase dev, vrai Stripe en mode test (webhooks reçus par
 *                             la CLI Stripe), faux Google (la connexion Google réelle ne s'automatise pas).
 *
 * Dans les deux cas : l'app compilée (`next start`, mode production) et le worker RÉEL dans son propre processus,
 * avec ses tâches périodiques, comme en production. Les emails vont dans une boîte locale (.data/recette/mail).
 */
const mode = process.env.RECETTE_ENV === 'reel' ? 'reel' : 'local';
const PORT = 3200;
const APP_URL = `http://localhost:${PORT}`;
const root = path.resolve('.data/recette');
await rm(root, { recursive: true, force: true });
await mkdir(path.join(root, 'mail'), { recursive: true });

const children: ChildProcess[] = [];
const stops: (() => Promise<void>)[] = [];
const env: Record<string, string> = {
  APP_SECRET: process.env.RECETTE_APP_SECRET ?? 'recette-secret-recette-secret-recette-secret',
  APP_URL,
  MAIL_DRIVER: 'local',
  MAIL_DIR: path.join(root, 'mail'),
  ALLOW_LOCAL_DRIVERS: '1',
  NODE_ENV: 'production',
};

const google = await startFakeGoogle({ port: 54520 });
Object.assign(env, google.env);

if (mode === 'local') {
  const pg = await startPostgres({ dir: path.join(root, 'pg'), port: 54510, persistent: false });
  stops.push(() => pg.stop());
  await migrate(pg.url, () => {});
  const stripe = await startFakeStripe({
    port: 54530, webhookSecret: 'whsec_recette_fake',
    webhook: async (payload, signature) => (await fetch(`${APP_URL}/api/stripe/webhook`, {
      method: 'POST', body: payload, headers: { 'content-type': 'application/json', 'stripe-signature': signature } })).status,
  });
  Object.assign(env, {
    DATABASE_URL: pg.url,
    STORAGE_DRIVER: 'local',
    STORAGE_DIR: path.join(root, 'storage'),
    STRIPE_SECRET_KEY: 'sk_test_recette_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_recette_fake',
    STRIPE_API_BASE: stripe.url,
  });
} else {
  for (const k of ['SUPABASE_DB_URL', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'STRIPE_SECRET_KEY']) {
    if (!process.env[k]) throw new Error(`Recette réelle : variable ${k} manquante`);
  }
  // Webhooks Stripe : la CLI écoute le compte de test et les renvoie à l'app (avec son propre secret de signature).
  const secret = await new Promise<string>((resolve, reject) => {
    const p = spawn('stripe', ['listen', '--api-key', process.env.STRIPE_SECRET_KEY!, '--print-secret'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout!.on('data', (d) => { out += d; });
    p.on('exit', () => { const m = /whsec_\w+/.exec(out); if (m) resolve(m[0]); else reject(new Error('stripe listen --print-secret a échoué')); });
  });
  const listen = spawn('stripe', ['listen', '--api-key', process.env.STRIPE_SECRET_KEY!, '--forward-to', `${APP_URL}/api/stripe/webhook`],
    { stdio: 'inherit' });
  children.push(listen);
  Object.assign(env, {
    DATABASE_URL: process.env.SUPABASE_DB_URL!,
    STORAGE_DRIVER: 'supabase',
    SUPABASE_URL: process.env.SUPABASE_URL!,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY!,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY!,
    STRIPE_WEBHOOK_SECRET: secret,
  });
}

// Fichier lu par les tests (boîte mail, base) : jamais de secret dedans, seulement le mode et les chemins.
await (await import('node:fs/promises')).writeFile(path.join(root, 'env.json'), JSON.stringify({ mode, appUrl: APP_URL, mailDir: env.MAIL_DIR }));

const childEnv = { ...process.env, ...env };
children.push(spawn('npx', ['next', 'start', '-p', String(PORT)], { stdio: 'inherit', env: childEnv }));
children.push(spawn('npx', ['tsx', 'worker/index.ts'], { stdio: 'inherit', env: childEnv }));

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  for (const s of stops) await s().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', (code) => { if (!stopping) { console.error(`processus arrêté (${code})`); void stop(); } });
await new Promise(() => {});
