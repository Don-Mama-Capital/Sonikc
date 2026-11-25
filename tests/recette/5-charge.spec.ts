import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { deleteAccount, expect, fixture, reel, signUp, test, trackIds, upload } from './kit';

/**
 * R8 / B4 — charge : des producteurs partagent chacun un beat, puis des dizaines d'auditeurs arrivent en même temps
 * (ouverture de la page, début d'écoute, audio, battements toutes les 5 s, comme le lecteur). Temps relevés,
 * erreurs serveur comptées, écoutes vérifiées dans les statistiques de chaque producteur.
 */
const PRODUCERS = reel() ? 2 : 5;
const LISTENERS = reel() ? 15 : 40;
const FILES = ['ref02_90_Cmaj.mp3', 'ref06_100_Gmin.mp3', 'ref07_120_Emin.wav', 'ref04_75_Dmin.aiff', 'ref10_110_Fmaj.aiff'];

type Sample = { kind: string; ms: number; status: number };
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };

test('@reel R8 Charge : producteurs et auditeurs simultanés, 0 erreur serveur, écoutes exactes', async ({ persona, baseURL }) => {
  test.setTimeout(420_000);
  // Les producteurs s'inscrivent et envoient leur beat en même temps.
  const producers = await Promise.all(Array.from({ length: PRODUCERS }, async (_, i) => {
    const who = await persona(`Producteur ${i + 1}`);
    await signUp(who.page, `Prod${i + 1}`);
    await upload(who.page, [fixture(FILES[i])], 1, 240_000);
    const trackId = Object.values(await trackIds(who.page))[0];
    await who.page.request.patch(`/api/share/track/${trackId}`, { data: { visibility: 'public' } });
    const link = await (await who.page.request.post(`/api/share/track/${trackId}/links`, { data: { label: 'Charge' } })).json();
    return { who, trackId, url: link.url as string, token: new URL(link.url).pathname.split('/').pop()! };
  }));

  const samples: Sample[] = [];
  const call = async (kind: string, url: string, init: RequestInit = {}) => {
    const t0 = performance.now();
    try {
      const res = await fetch(new URL(url, baseURL), { ...init, headers: { origin: baseURL!, 'content-type': 'application/json', ...(init.headers ?? {}) } });
      const body = kind === 'audio' ? Buffer.from(await res.arrayBuffer()) : await res.text();
      samples.push({ kind, ms: performance.now() - t0, status: res.status });
      return { res, body };
    } catch {
      samples.push({ kind, ms: performance.now() - t0, status: 0 });
      return null;
    }
  };

  // Les auditeurs arrivent tous ensemble, répartis sur les liens.
  const assigned = new Map<string, number>();
  await Promise.all(Array.from({ length: LISTENERS }, async (_, n) => {
    const p = producers[n % PRODUCERS];
    assigned.set(p.trackId, (assigned.get(p.trackId) ?? 0) + 1);
    const pv = randomUUID();
    const html = await call('page', p.url);
    const src = /\/api\/s\/[A-Za-z0-9_-]+\/audio\/[0-9a-f-]{36}\?exp=\d+(?:&amp;|\\u0026|&)sig=[A-Za-z0-9_-]+/.exec(String(html?.body ?? ''))?.[0]
      ?.replace(/&amp;|\\u0026/g, '&');
    await call('view', `/api/s/${p.token}/view`, { method: 'POST', body: JSON.stringify({ pv }) });
    const start = await call('listen', `/api/s/${p.token}/listen`, { method: 'POST', body: JSON.stringify({ action: 'start', trackId: p.trackId, pv }) });
    if (src) await call('audio', src, { headers: { range: 'bytes=0-262143' } });
    const sessionId = start ? JSON.parse(String(start.body)).sessionId : null;
    for (let b = 1; b <= 3 && sessionId; b++) {
      await new Promise((r) => setTimeout(r, 5000));
      await call('beat', `/api/s/${p.token}/listen`, { method: 'POST', body: JSON.stringify({ action: 'beat', sessionId, playedMs: b * 5000, pv }) });
    }
  }));

  const kinds = [...new Set(samples.map((s) => s.kind))];
  const report = {
    environnement: reel() ? 'réel (Supabase dev + Stripe test)' : 'simulation locale',
    producteurs: PRODUCERS, auditeurs: LISTENERS, requetes: samples.length,
    erreurs_serveur: samples.filter((s) => s.status >= 500 || s.status === 0).length,
    refus: samples.filter((s) => s.status >= 400 && s.status < 500).map((s) => `${s.kind} ${s.status}`),
    temps_ms: Object.fromEntries(kinds.map((k) => {
      const ms = samples.filter((s) => s.kind === k).map((s) => s.ms);
      return [k, { n: ms.length, p50: Math.round(pct(ms, 0.5)), p95: Math.round(pct(ms, 0.95)), max: Math.round(Math.max(...ms)) }];
    })),
  };
  await mkdir('test-results/recette', { recursive: true });
  await writeFile(`test-results/recette/charge-${reel() ? 'reel' : 'local'}.json`, JSON.stringify(report, null, 2));
  test.info().annotations.push({ type: 'charge', description: JSON.stringify(report.temps_ms) });

  expect(report.erreurs_serveur, 'erreurs serveur pendant la charge').toBe(0);
  expect(report.refus, 'requêtes refusées pendant la charge').toEqual([]);
  expect(report.temps_ms.audio?.n ?? 0, 'audio servi à chaque auditeur').toBe(LISTENERS);
  if (!reel()) expect(report.temps_ms.page.p95, 'pages partagées : p95 (ms)').toBeLessThan(1500);

  // Chaque producteur voit exactement ses auditeurs.
  for (const p of producers) {
    const stats = (await (await p.who.page.request.get(`/api/stats/track/${p.trackId}`)).json()).track;
    expect(stats.plays, `écoutes du beat ${p.trackId}`).toBe(assigned.get(p.trackId));
    expect(stats.listeners).toBe(assigned.get(p.trackId));
  }
  for (const p of producers) await deleteAccount(p.who.page);
});
