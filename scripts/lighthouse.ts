import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';

/**
 * Audit Lighthouse (mobile) des pages de la phase 1, contre l'environnement de recette
 * (`npx tsx scripts/e2e-server.ts` déjà lancé sur le port 3100). Crée un compte et un morceau de test.
 */
const BASE = 'http://localhost:3100';
const MAIL_DIR = path.resolve('.data/e2e/mail');
const email = `lh_${Date.now()}@test.local`;
let cookie = '';

async function call(p: string, init: RequestInit = {}) {
  const res = await fetch(BASE + p, { ...init, headers: { 'content-type': 'application/json', origin: BASE, cookie, ...(init.headers ?? {}) } });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return res;
}

await call('/api/auth/request-code', { method: 'POST', body: JSON.stringify({ email }) });
let code = '';
for (const f of (await readdir(MAIL_DIR)).sort().reverse()) {
  const m = JSON.parse(await readFile(path.join(MAIL_DIR, f), 'utf8'));
  if (m.to === email) { code = /(\d{6})/.exec(m.subject)![1]; break; }
}
await call('/api/auth/verify', { method: 'POST', body: JSON.stringify({ email, code }) });
const handle = `lh_${Date.now() % 1e6}`;
await call('/api/profile', { method: 'POST', body: JSON.stringify({ handle, displayName: 'Audit' }) });
const file = await readFile('tests/fixtures/generated/ref01_140_Amin.wav');
const t = await (await call('/api/uploads', { method: 'POST', body: JSON.stringify({ filename: 'Lueur froide.wav', size: file.length }) })).json();
await fetch(BASE + t.uploadUrl, { method: 'PUT', body: file });
await call(t.completeUrl, { method: 'POST' });
for (let i = 0; i < 60; i++) {
  const lib = await (await call('/api/library')).json();
  if (lib.tracks?.[0]?.version?.status === 'ready') break;
  await new Promise((r) => setTimeout(r, 500));
}

await call(`/api/share/track/${t.trackId}`, { method: 'PATCH', body: JSON.stringify({ visibility: 'public' }) });
const link = await (await call(`/api/share/track/${t.trackId}/links`, { method: 'POST', body: JSON.stringify({ label: 'Audit' }) })).json();
const sharedPath = new URL(link.url).pathname;
await call(`/api/share/track/${t.trackId}`, { method: 'PATCH', body: JSON.stringify({ visibility: 'for_sale' }) });
await call('/api/profile/public', { method: 'PUT', body: JSON.stringify({ bio: 'Beats trap et drill.', links: { instagram: 'instagram.com/audit' } }) });

const pages = [
  { name: 'connexion', url: '/login', auth: false },
  { name: 'bibliotheque', url: '/app', auth: true },
  { name: 'morceau', url: `/app/tracks/${t.trackId}`, auth: true },
  { name: 'partage', url: sharedPath, auth: false },
  { name: 'page-publique', url: `/${handle}`, auth: false },
];
const chrome = await chromeLauncher.launch({ chromePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', chromeFlags: ['--headless=new', '--no-sandbox'] });
const out: Record<string, Record<string, number>> = {};
await mkdir('test-results/lighthouse', { recursive: true });
try {
  for (const p of pages) {
    const r = await lighthouse(BASE + p.url, {
      port: chrome.port, output: 'html', logLevel: 'error', formFactor: 'mobile', screenEmulation: { mobile: true, width: 375, height: 812, deviceScaleFactor: 2, disabled: false },
      onlyCategories: ['accessibility', 'best-practices', 'performance', 'seo'],
      extraHeaders: p.auth ? { Cookie: cookie } : undefined,
    });
    const cats = r!.lhr.categories;
    out[p.name] = Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, Math.round((v.score ?? 0) * 100)]));
    await writeFile(`test-results/lighthouse/${p.name}.html`, r!.report as string);
    const failing = Object.values(r!.lhr.audits).filter((a) => a.score !== null && a.score < 1 && r!.lhr.categories.accessibility.auditRefs.some((x) => x.id === a.id));
    if (failing.length) console.log(`${p.name} — accessibilité à corriger :`, failing.map((a) => `${a.id}: ${a.title}`).join(' | '));
  }
} finally {
  await chrome.kill();
}
console.log(JSON.stringify(out, null, 2));
