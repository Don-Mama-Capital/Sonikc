import { expect, test } from '@playwright/test';
import { fixture, signUp } from './helpers';

test('conformité : aucun traceur avant accord, bandeau équilibré, pages légales, export et suppression', async ({ page, browser }) => {
  // Un producteur partage un morceau public.
  await signUp(page);
  await page.getByTestId('consent-refuse').click();
  await page.getByTestId('file-input').setInputFiles([fixture('ref06_100_Gmin.mp3')]);
  await expect(page.getByTestId('track-row').filter({ hasText: 'BPM' })).toHaveCount(1, { timeout: 60_000 });
  const lib = await (await page.request.get('/api/library')).json();
  const trackId = lib.tracks[0].id as string;
  await page.request.patch(`/api/share/track/${trackId}`, { data: { visibility: 'public' } });
  const link = await (await page.request.post(`/api/share/track/${trackId}/links`, { data: { label: 'Test' } })).json();

  // Auditeur : bandeau visible, « Refuser » et « Accepter » au même niveau ; écoute sans aucun cookie de mesure.
  const ctx = await browser.newContext();
  const visitor = await ctx.newPage();
  await visitor.goto(new URL(link.url).pathname);
  const refuse = visitor.getByTestId('consent-refuse'), accept = visitor.getByTestId('consent-accept');
  await expect(refuse).toBeVisible();
  expect(await refuse.getAttribute('class')).toBe(await accept.getAttribute('class'));
  const [rb, ab] = [await refuse.boundingBox(), await accept.boundingBox()];
  expect(Math.abs(rb!.width - ab!.width)).toBeLessThan(2);
  expect(Math.abs(rb!.y - ab!.y)).toBeLessThan(2);
  await visitor.screenshot({ path: 'test-results/bandeau-cookies.png' });
  await visitor.getByRole('button', { name: /Écouter/ }).first().click();
  await expect.poll(() => visitor.evaluate(() => document.querySelector('audio')?.currentTime ?? 0), { timeout: 15_000 }).toBeGreaterThan(1);
  await visitor.waitForTimeout(6000); // un battement d'écoute
  let names = (await ctx.cookies()).map((c) => c.name);
  expect(names).not.toContain('sk_vid');
  expect(await visitor.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  // L'écoute est quand même comptée pour le producteur.
  const stats = (await (await page.request.get(`/api/stats/track/${trackId}`)).json()).track;
  expect(stats.plays).toBeGreaterThanOrEqual(1);

  // Accepter pose le cookie de mesure ; refuser ensuite l'efface.
  await accept.click();
  await visitor.reload();
  await visitor.getByRole('button', { name: /Écouter/ }).first().click();
  await expect.poll(async () => (await ctx.cookies()).map((c) => c.name), { timeout: 15_000 }).toContain('sk_vid');
  await visitor.goto('/cookies');
  await expect(visitor.getByTestId('cookie-list')).toContainText('sk_vid');
  await visitor.getByTestId('consent-reopen').click();
  await visitor.getByTestId('consent-refuse').click();
  await expect.poll(async () => (await ctx.cookies()).map((c) => c.name)).not.toContain('sk_vid');

  // Pages légales : en place, passages à compléter signalés, liens dans le pied de page.
  for (const path of ['/mentions-legales', '/cgu', '/cgv', '/confidentialite']) {
    await visitor.goto(path);
    await expect(visitor.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(visitor.getByTestId('todo').first()).toBeVisible();
    await expect(visitor.getByTestId('footer')).toContainText('Confidentialité');
  }
  await visitor.screenshot({ path: 'test-results/page-legale.png', fullPage: true });

  // Export puis suppression du compte du producteur.
  await page.goto('/compte');
  const download = page.waitForEvent('download');
  await page.getByTestId('export').click();
  const file = await download;
  const json = JSON.parse(await (await import('node:fs/promises')).readFile((await file.path())!, 'utf8'));
  expect(json.morceaux).toHaveLength(1);
  const handle = json.profil[0].handle as string;
  await page.getByTestId('delete-confirm').fill(handle);
  await page.getByTestId('delete-go').click();
  await expect(page).toHaveURL(/\/\?compte=supprime/);
  expect((await page.request.get('/api/library')).status()).toBe(401);
  expect((await visitor.goto(new URL(link.url).pathname))?.status()).toBe(404);
});
