import { expect, test } from '@playwright/test';
import { fixture, signUp } from './helpers';

const audioState = (page: import('@playwright/test').Page) =>
  page.getByTestId('audio').evaluate((a: HTMLAudioElement) => ({ paused: a.paused, t: a.currentTime }));

test('la lecture continue quand on change de page', async ({ page }) => {
  await signUp(page);
  await page.getByTestId('file-input').setInputFiles([fixture('ref03_128_F#min.flac'), fixture('ref10_110_Fmaj.aiff')]);
  await expect(page.getByTestId('processing')).toHaveCount(0, { timeout: 40_000 });
  await expect(page.getByTestId('track-row')).toHaveCount(2);

  await page.getByTestId('play-track').first().click();
  await expect(page.getByTestId('player')).toBeVisible();
  await expect.poll(async () => (await audioState(page)).t, { timeout: 15_000 }).toBeGreaterThan(0.5);
  const title = await page.getByTestId('player-title').textContent();

  // Navigation côté client : vers le détail du morceau, puis la corbeille, puis retour.
  await page.getByTestId('track-row').nth(1).getByRole('link').click();
  await expect(page.getByTestId('track-title')).toBeVisible();
  await page.getByRole('link', { name: 'Corbeille' }).click();
  await expect(page.getByRole('heading', { name: 'Corbeille' })).toBeVisible();
  const before = await audioState(page);
  expect(before.paused).toBe(false);
  await page.waitForTimeout(1500);
  const after = await audioState(page);
  expect(after.paused).toBe(false);
  expect(after.t).toBeGreaterThan(before.t);
  await expect(page.getByTestId('player-title')).toHaveText(title!);

  await page.getByTestId('player-toggle').click();
  await expect.poll(async () => (await audioState(page)).paused).toBe(true);
});

test('utilisable sur mobile (375 px) : pas de défilement horizontal, lecteur visible', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signUp(page);
  await page.getByTestId('file-input').setInputFiles(fixture('ref05_160_Ebmaj.wav'));
  await expect(page.getByTestId('processing')).toHaveCount(0, { timeout: 40_000 });
  await page.getByTestId('play-track').first().click();
  await expect(page.getByTestId('player')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await page.getByTestId('player-toggle').boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(40);
  await page.screenshot({ path: 'test-results/mobile-375-library.png', fullPage: false });
  await page.getByTestId('track-row').first().getByRole('link').click();
  await expect(page.getByTestId('track-title')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: 'test-results/mobile-375-track.png', fullPage: true });
});
