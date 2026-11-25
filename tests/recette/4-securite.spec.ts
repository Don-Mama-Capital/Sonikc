import { a11y, deleteAccount, expect, fixture, signUp, test, trackIds, upload } from './kit';

const refused = (s: number) => [401, 403, 404].includes(s);

/** R7 : chacun ne voit et ne touche que ce qui est à lui ; liens révoqués, mots de passe, adresses signées. */
test('@reel R7 Sécurité vue utilisateur : accès croisés refusés, lien révoqué, mot de passe, adresses audio signées', async ({ persona }) => {
  const kim = await persona('Kim');
  const tom = await persona('Tom');
  const anon = await persona('Anonyme');
  await Promise.all([signUp(kim.page, 'Kim', { plan: 'studio' }), signUp(tom.page, 'Tom')]);
  await upload(kim.page, [fixture('ref03_128_F#min.flac')], 1, 180_000);
  const id = Object.values(await trackIds(kim.page))[0];

  // Tom (connecté) et un anonyme essaient d'atteindre le morceau privé de Kim.
  for (const [who, page] of [['Tom', tom.page], ['anonyme', anon.page]] as const) {
    const r = page.request;
    for (const [method, url] of [['GET', `/api/tracks/${id}`], ['GET', `/api/stats/track/${id}`], ['PATCH', `/api/share/track/${id}`],
      ['DELETE', `/api/tracks/${id}`], ['POST', `/api/share/track/${id}/links`], ['GET', '/api/account/export']] as const) {
      const res = await r.fetch(url, { method, data: method === 'GET' ? undefined : { visibility: 'public', label: 'x' } });
      expect(refused(res.status()) || (who === 'Tom' && url === '/api/account/export' && res.status() === 200), `${who} ${method} ${url} → ${res.status()}`).toBe(true);
    }
    const page404 = await page.goto(`/app/tracks/${id}`);
    expect(page404?.status() === 404 || /\/login/.test(page.url()), `${who} ouvre la fiche de Kim`).toBe(true);
  }
  // L'export de Tom ne contient rien de Kim.
  expect(JSON.stringify(await (await tom.page.request.get('/api/account/export')).json())).not.toContain(id);
  // Le morceau de Kim est intact.
  expect((await kim.page.request.get(`/api/tracks/${id}`)).status()).toBe(200);

  // Requête venue d'un autre site (CSRF) : refusée.
  const csrf = await tom.page.request.post('/api/account/delete', { headers: { origin: 'https://site-pirate.example' }, data: { confirm: 'x' } });
  expect(csrf.status()).toBe(403);

  // Lien protégé (offre Studio) : mauvais mot de passe refusé, bon mot de passe accepté.
  await kim.page.request.patch(`/api/share/track/${id}`, { data: { visibility: 'public' } });
  const link = await (await kim.page.request.post(`/api/share/track/${id}/links`, { data: { label: 'Privé label' } })).json();
  await kim.page.request.patch(`/api/share/track/${id}`, { data: { password: 'cle-secrete-2026' } });
  await anon.page.goto(link.url);
  await anon.page.getByTestId('consent-refuse').click();
  await anon.page.getByLabel('Mot de passe').fill('mauvais-mot');
  await anon.page.getByRole('button', { name: 'Accéder' }).click();
  await expect(anon.page.locator('p[role=alert]')).toHaveText('Mot de passe incorrect.');
  await a11y(anon.page, 'partage-protege');
  await anon.page.getByLabel('Mot de passe').fill('cle-secrete-2026');
  await anon.page.getByRole('button', { name: 'Accéder' }).click();
  await expect(anon.page.getByTestId('shared-title')).toBeVisible();

  // Adresse audio : signée et limitée dans le temps ; modifiée, elle est refusée.
  await anon.page.getByRole('button', { name: /^Écouter / }).first().click();
  await expect.poll(() => anon.page.evaluate(() => document.querySelector('audio')?.getAttribute('src') ?? '')).toContain('sig=');
  const src = await anon.page.evaluate(() => document.querySelector('audio')!.getAttribute('src')!);
  expect(src).toMatch(/exp=\d+/);
  expect((await anon.page.request.get(src.replace(/sig=[^&]+/, 'sig=modifiee'))).status()).toBe(403);
  // Sans le cookie du lien déverrouillé, l'adresse ne sert à rien.
  expect(refused((await tom.page.request.get(new URL(src, anon.page.url()).toString())).status())).toBe(true);

  // Lien révoqué : la page et l'audio disparaissent.
  await kim.page.request.delete(`/api/share/links/${link.id}`);
  expect((await anon.page.goto(link.url))?.status()).toBe(404);
  expect((await anon.page.request.get(src)).status()).toBe(404);

  await deleteAccount(kim.page);
  await deleteAccount(tom.page);
});
