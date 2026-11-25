import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';

/**
 * Outils de la recette utilisateurs (docs/recette.md).
 * Chaque page ouverte est surveillée : erreurs de la console, erreurs JavaScript, réponses 5xx (critère R9).
 */
const ROOT = path.resolve('.data/recette');
const OUT = path.resolve('test-results/recette');
type Env = { mode: 'local' | 'reel'; appUrl: string; mailDir: string };
export const env = (): Env => JSON.parse(readFileSync(path.join(ROOT, 'env.json'), 'utf8'));
export const reel = () => env().mode === 'reel';
export const fixture = (name: string) => path.resolve('tests/fixtures/generated', name);

/** Accès direct à la base, réservé à la préparation (offre posée pour un personnage) et aux vérifications. */
export function db() {
  const url = reel() ? process.env.SUPABASE_DB_URL! : 'postgres://postgres:postgres@127.0.0.1:54510/sonikc';
  return postgres(url, { max: 1, onnotice: () => {}, prepare: !reel() });
}
export async function sql<T>(fn: (s: postgres.Sql) => Promise<T>) {
  const s = db();
  try { return await fn(s); } finally { await s.end(); }
}

// Messages attendus (refus volontaires des tests de sécurité, ressources refusées exprès) : pas des anomalies.
const EXPECTED = [/status of 4\d\d/, /favicon/, /net::ERR_ABORTED/, /AbortError/, /The play\(\) request was interrupted/];
type Issue = { test: string; who: string; kind: 'console' | 'pageerror' | '5xx'; text: string };

export class Watch {
  issues: Issue[] = [];
  constructor(private readonly testName: string) {}
  page(p: Page, who: string) {
    p.on('console', (m) => {
      if (m.type() === 'error' && !EXPECTED.some((r) => r.test(m.text()))) this.issues.push({ test: this.testName, who, kind: 'console', text: m.text().slice(0, 400) });
    });
    p.on('pageerror', (e) => this.issues.push({ test: this.testName, who, kind: 'pageerror', text: String(e).slice(0, 400) }));
    p.on('response', (r) => {
      if (r.status() >= 500) this.issues.push({ test: this.testName, who, kind: '5xx', text: `${r.status()} ${r.request().method()} ${r.url()}` });
    });
    return p;
  }
}

/** Un personnage : son propre navigateur (cookies séparés), surveillé. */
export type Persona = { name: string; ctx: BrowserContext; page: Page };

export const test = base.extend<{ watch: Watch; persona: (name: string, opts?: BrowserContextOptions) => Promise<Persona> }>({
  watch: async ({}, use, info) => {
    const w = new Watch(info.title);
    await use(w);
    await mkdir(OUT, { recursive: true });
    for (const i of w.issues) await appendFile(path.join(OUT, 'anomalies.jsonl'), JSON.stringify(i) + '\n');
    expect(w.issues, `Anomalies pendant « ${info.title} » (console, JavaScript, 5xx)`).toEqual([]);
  },
  persona: async ({ browser, watch }, use) => {
    const opened: BrowserContext[] = [];
    await use(async (name, opts) => {
      const ctx = await (browser as Browser).newContext(opts);
      opened.push(ctx);
      ctx.on('page', (p) => watch.page(p, name));
      const page = await ctx.newPage();
      return { name, ctx, page };
    });
    for (const c of opened) await c.close().catch(() => {});
  },
});
export { expect };

export const MOBILE = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } as const;

/** Capture d'écran rangée par parcours. */
export async function shot(page: Page, name: string, fullPage = true) {
  await mkdir(path.join(OUT, 'captures'), { recursive: true });
  await page.screenshot({ path: path.join(OUT, 'captures', `${name}.png`), fullPage });
}

/** Accessibilité (axe) : aucun problème « grave » ou « critique » ; le détail est gardé pour le rapport. */
export async function a11y(page: Page, name: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  await mkdir(OUT, { recursive: true });
  await appendFile(path.join(OUT, 'accessibilite.jsonl'), JSON.stringify({ page: name, url: page.url(),
    violations: r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, target: v.nodes[0]?.target })) }) + '\n');
  expect(bad.map((v) => `${v.id} (${v.impact}) : ${v.help} — ${v.nodes.length} élément(s), ex. ${JSON.stringify(v.nodes[0]?.target)}`), `Accessibilité : ${name}`).toEqual([]);
}

/** Pas de défilement horizontal (mobile). */
export async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

/** Boîte mail locale de la recette. */
export async function mail(to: string, tag: string, opts: { after?: number; match?: RegExp } = {}) {
  const dir = env().mailDir;
  for (let i = 0; i < 160; i++) {
    const files = (await readdir(dir).catch(() => [] as string[])).sort().reverse();
    for (const f of files) {
      const m = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
      if (m.to === to && m.tag === tag && (!opts.match || opts.match.test(m.text ?? ''))) return m as { to: string; subject: string; text: string; html: string };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`aucun email « ${tag} » pour ${to}`);
}
export async function mails(to: string, tag: string) {
  const dir = env().mailDir;
  const out = [];
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    const m = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
    if (m.to === to && m.tag === tag) out.push(m);
  }
  return out;
}

/** Connexion par code sur la page de connexion déjà ouverte. */
export async function loginHere(page: Page, email: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Recevoir un code' }).click();
  await expect(page.getByLabel('Code à 6 chiffres')).toBeVisible();
  const m = await mail(email, 'login_code');
  await page.getByLabel('Code à 6 chiffres').fill(/(\d{6})/.exec(m.subject)![1]);
  await page.getByRole('button', { name: 'Se connecter' }).click();
}

/** Adresse de recette reconnaissable (nettoyage de l'environnement réel). */
export const address = (who: string) => `recette+${who.toLowerCase()}-${randomUUID().slice(0, 8)}@sonikc.test`;

/** Inscription complète d'un producteur : code email, profil, bibliothèque. */
export async function signUp(page: Page, who: string, opts: { email?: string; plan?: 'free' | 'pro' | 'studio' } = {}) {
  const email = opts.email ?? address(who);
  const tag = randomUUID().slice(0, 6);
  const handle = `${who.toLowerCase()}_${tag}`;
  await page.goto('/login');
  await loginHere(page, email);
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel('Nom d’artiste').fill(`${who} ${tag}`);
  await page.getByLabel('Identifiant').fill(handle);
  await page.getByRole('button', { name: 'Créer mon profil' }).click();
  await expect(page).toHaveURL(/\/app$/);
  // L'offre d'un personnage payant est posée en base (le parcours d'abonnement a son propre test : R5).
  if (opts.plan && opts.plan !== 'free') await sql((s) => s`update profiles set plan = ${opts.plan!} where handle = ${handle}`);
  return { email, handle, name: `${who} ${tag}` };
}

/** Envoie des fichiers depuis la bibliothèque et attend l'analyse du worker (BPM affiché). */
export async function upload(page: Page, files: string[], expected: number, timeout = 120_000) {
  await page.getByTestId('file-input').setInputFiles(files);
  await expect(page.getByTestId('track-row').filter({ hasText: 'BPM' })).toHaveCount(expected, { timeout });
}

export async function trackIds(page: Page) {
  const lib = await (await page.request.get('/api/library')).json();
  return Object.fromEntries(lib.tracks.map((t: { title: string; id: string }) => [t.title, t.id])) as Record<string, string>;
}

/** Écoute réelle dans le navigateur pendant au moins `seconds` secondes, puis pause. */
export async function listen(page: Page, title: RegExp | string, seconds: number) {
  await page.getByRole('button', { name: typeof title === 'string' ? new RegExp(`^Écouter ${title}`) : title }).first().click();
  await expect.poll(() => page.evaluate(() => document.querySelector('audio')?.currentTime ?? 0), { timeout: 30_000 + seconds * 1000, intervals: [500] })
    .toBeGreaterThan(seconds);
  await page.getByRole('button', { name: /^Pause / }).first().click();
}

/** Supprime le compte connecté par le parcours normal (« Mes données »). */
export async function deleteAccount(page: Page, opts: { renounce?: boolean } = {}) {
  await page.goto('/compte');
  // Le mot à taper est affiché (identifiant, ou email sans profil de producteur).
  const word = await page.locator('label', { hasText: 'pour confirmer' }).locator('strong').innerText();
  await page.getByTestId('delete-confirm').fill(word);
  await page.getByTestId('delete-go').click();
  if (opts.renounce) {
    await expect(page.getByTestId('delete-renounce')).toBeVisible();
    await page.getByTestId('delete-renounce').check();
    await page.getByTestId('delete-go').click();
  }
  await expect(page).toHaveURL(/\/\?compte=supprime/);
}
