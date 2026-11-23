import { expect, test } from '@playwright/test';
import { fixture, signUp } from './helpers';

const seconds = (txt: string) => { const [m, s] = txt.trim().split(':').map(Number); return m * 60 + s; };

test('écoute réelle suivie : durée à ± 5 s, rechargement sans double compte, notification en moins de 10 s, stats', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await signUp(page);
  await page.getByTestId('file-input').setInputFiles(fixture('ref02_90_Cmaj.mp3'));
  await expect(page.getByTestId('track-row').filter({ hasText: 'BPM' })).toHaveCount(1, { timeout: 60_000 });
  const lib = await (await page.request.get('/api/library')).json();
  const trackId = lib.tracks[0].id as string;
  await page.request.patch(`/api/share/track/${trackId}`, { data: { visibility: 'public' } });
  const link = await (await page.request.post(`/api/share/track/${trackId}/links`, { data: { label: 'DM label' } })).json();
  await page.goto(`/app/tracks/${trackId}`);
  await expect(page.getByTestId('bell')).toBeVisible();

  const listener = await (await browser.newContext()).newPage();
  await listener.goto(link.url);
  // Le dédoublonnage au rechargement repose sur le cookie de mesure : l'auditeur l'accepte ici
  // (sans accord, l'écoute est comptée quand même — voir compliance.spec.ts).
  await listener.getByTestId('consent-accept').click();
  await expect(listener.getByTestId('tracking-notice')).toContainText('voit les écoutes de ce lien');
  await listener.screenshot({ path: 'test-results/listen-notice.png' });
  const t0 = Date.now();
  await listener.getByRole('button', { name: /^Écouter / }).click();

  // Notification chez le propriétaire en moins de 10 s après le début de l'écoute.
  await expect(page.getByTestId('bell-count')).toHaveText('1', { timeout: 10_000 });
  expect(Date.now() - t0).toBeLessThan(10_000);

  // 12 s d'écoute réelle, puis pause.
  await expect.poll(() => listener.evaluate(() => document.querySelector('audio')!.currentTime), { timeout: 30_000, intervals: [500] }).toBeGreaterThan(12);
  await listener.getByRole('button', { name: /^Pause / }).click();
  const played = await listener.evaluate(() => document.querySelector('audio')!.currentTime);

  // Rechargement + nouvelle lecture : toujours une seule écoute.
  await listener.reload();
  await listener.getByRole('button', { name: /^Écouter / }).click();
  await expect.poll(() => listener.evaluate(() => document.querySelector('audio')!.currentTime), { timeout: 15_000 }).toBeGreaterThan(2);
  await listener.getByRole('button', { name: /^Pause / }).click();
  const played2 = await listener.evaluate(() => document.querySelector('audio')!.currentTime);

  await page.reload();
  await expect(page.getByTestId('stat-plays')).toHaveText('1', { timeout: 15_000 });
  await expect(page.getByTestId('stat-listeners')).toHaveText('1');
  const total = seconds(await page.getByTestId('stat-total').innerText());
  expect(Math.abs(total - (played + played2))).toBeLessThanOrEqual(5);
  await expect(page.getByTestId('recent-listen')).toHaveCount(1);
  await expect(page.getByTestId('recent-listen')).toContainText('Anonyme');
  await expect(page.getByTestId('recent-listen')).toContainText('DM label');
  await expect(page.getByTestId('funnel-row').filter({ hasText: 'DM label' })).toContainText('1');
  await page.getByTestId('stats').screenshot({ path: 'test-results/stats.png' });

  // La cloche liste l'écoute.
  await page.getByTestId('bell').click();
  await expect(page.getByTestId('notification').first()).toContainText('écoute');
});
