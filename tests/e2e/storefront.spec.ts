import { expect, test } from '@playwright/test';
import { fixture, signUp } from './helpers';

test('page publique : seuls les morceaux publics, filtres, licences lisibles, écoute', async ({ page, browser }) => {
  const { handle } = await signUp(page);
  await page.getByTestId('file-input').setInputFiles([fixture('ref02_90_Cmaj.mp3'), fixture('ref06_100_Gmin.mp3'), fixture('ref01_140_Amin.wav')]);
  await expect(page.getByTestId('track-row').filter({ hasText: 'BPM' })).toHaveCount(3, { timeout: 90_000 });
  const lib = await (await page.request.get('/api/library')).json();
  const id = Object.fromEntries(lib.tracks.map((t: { title: string; id: string }) => [t.title, t.id]));
  await page.request.patch(`/api/share/track/${id['ref01 140 Amin']}`, { data: { visibility: 'for_sale' } });
  await page.request.patch(`/api/share/track/${id['ref06 100 Gmin']}`, { data: { visibility: 'public' } });
  // ref02 reste privé. ref01 est un WAV : les licences WAV peuvent être livrées.

  // Réglages : profil et une licence modifiée depuis « Ma page ».
  await page.goto('/app/boutique');
  await page.getByLabel('Présentation').fill('Beats trap à Paris');
  await page.getByLabel('Instagram').fill('instagram.com/test');
  await page.getByRole('button', { name: 'Enregistrer le profil' }).click();
  await expect(page.getByText('Profil enregistré.')).toBeVisible();
  await expect(page.getByTestId('template')).toHaveCount(3);
  await page.getByTestId('template').filter({ hasText: 'Basique' }).getByRole('button', { name: 'Modifier' }).click();
  await page.getByTestId('template-form').getByLabel('Prix HT (€)').fill('25');
  await page.getByTestId('template-form').getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByTestId('template').filter({ hasText: 'Basique' })).toContainText('25,00 € HT');

  const visitor = await (await browser.newContext({ viewport: { width: 375, height: 800 } })).newPage();
  await visitor.goto(`/${handle}`);
  await expect(visitor.getByTestId('store-bio')).toHaveText('Beats trap à Paris');
  await expect(visitor.getByRole('link', { name: 'Instagram' })).toHaveAttribute('href', 'https://instagram.com/test');
  await expect(visitor.getByTestId('store-track')).toHaveCount(2);
  await expect(visitor.getByTestId('store-tracks')).not.toContainText('ref02');
  // 25 € HT + 20 % = 30 € TTC (France).
  await expect(visitor.getByTestId('store-track').filter({ hasText: 'ref01' }).getByTestId('store-price')).toContainText('30,00');
  await visitor.getByTestId('store-track').filter({ hasText: 'ref01' }).getByText('Voir les licences').click();
  const licences = visitor.getByTestId('licence');
  await expect(licences).toHaveCount(3);
  await expect(licences.first()).toContainText('Fichiers : MP3');
  for (const raw of ['max_streams', 'null', 'true', 'false']) await expect(visitor.getByTestId('licences')).not.toContainText(raw);
  const overflow = await visitor.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await visitor.screenshot({ path: 'test-results/store-mobile.png', fullPage: true });

  // Filtres (formulaire sans JavaScript côté serveur).
  await visitor.getByLabel('BPM max').fill('120');
  await visitor.getByRole('button', { name: 'Filtrer' }).click();
  await expect(visitor.getByTestId('store-track')).toHaveCount(1);
  await expect(visitor.getByTestId('store-track')).toContainText('ref06');
  await visitor.getByLabel('Tonalité').selectOption({ label: 'A min' });
  await visitor.getByRole('button', { name: 'Filtrer' }).click();
  await expect(visitor.getByTestId('store-empty')).toBeVisible();
  await visitor.getByRole('link', { name: 'Effacer' }).click();
  await expect(visitor.getByTestId('store-track')).toHaveCount(2);

  // Écoute de l'extrait.
  await visitor.getByRole('button', { name: /Écouter ref06/ }).click();
  await expect.poll(() => visitor.evaluate(() => document.querySelector('audio')?.currentTime ?? 0), { timeout: 15_000 }).toBeGreaterThan(0.5);

  // Licence désactivée pour ce morceau : masquée.
  const tpls = await (await page.request.get('/api/licences')).json();
  await page.request.put(`/api/tracks/${id['ref01 140 Amin']}/licences/${tpls[2].id}`, { data: { enabled: false } });
  await visitor.reload();
  await visitor.getByTestId('store-track').filter({ hasText: 'ref01' }).getByText('Voir les licences').click();
  await expect(visitor.getByTestId('licence')).toHaveCount(2);

  // Identifiant inconnu : page introuvable.
  const res = await visitor.goto('/personne_inconnue_xyz');
  expect(res?.status()).toBe(404);
});
