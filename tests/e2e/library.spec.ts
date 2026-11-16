import { expect, test } from '@playwright/test';
import { fixture, signUp } from './helpers';

test('envoyer un beat : analyse, BPM et tonalité, puis correction à la main', async ({ page }) => {
  await signUp(page);
  await page.getByTestId('file-input').setInputFiles(fixture('ref01_140_Amin.wav'));
  const row = page.getByTestId('track-row').filter({ hasText: 'ref01 140 Amin' });
  await expect(row).toContainText('140 BPM · A min', { timeout: 30_000 });
  await row.getByRole('link', { name: /ref01 140 Amin/ }).click();
  await expect(page.getByTestId('track-title')).toHaveText('ref01 140 Amin');
  await page.getByLabel(/Tonalité/).fill('C maj');
  await page.getByLabel(/^BPM/).fill('70');
  await page.getByLabel('Tags').fill('#dark #trap');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByTestId('saved')).toBeVisible();
  await page.goto('/app');
  await expect(page.getByTestId('track-row').first()).toContainText('70 BPM · C maj');
  await expect(page.getByTestId('track-row').first()).toContainText('#dark');
});

test('notation des tonalités : dièses ou bémols, au choix', async ({ page }) => {
  await signUp(page);
  await page.getByTestId('file-input').setInputFiles(fixture('ref08_85_Bbmaj.flac'));
  const row = page.getByTestId('track-row').first();
  await expect(row).toContainText('85 BPM · A# maj', { timeout: 30_000 });
  await page.getByTestId('notation').click();
  await expect(row).toContainText('85 BPM · Bb maj');
  await page.reload();
  await expect(page.getByTestId('track-row').first()).toContainText('Bb maj');
});

test('dossiers : créer, ranger, supprimer sans perdre le contenu ; recherche par BPM', async ({ page }) => {
  await signUp(page);
  await page.getByTestId('file-input').setInputFiles([fixture('ref02_90_Cmaj.mp3'), fixture('ref07_120_Emin.wav')]);
  await expect(page.getByTestId('track-row')).toHaveCount(2);
  await expect(page.getByTestId('processing')).toHaveCount(0, { timeout: 40_000 });

  await page.getByRole('button', { name: '+ Dossier' }).click();
  await page.getByLabel('Nom du dossier').fill('Juin 2026');
  await page.getByRole('button', { name: 'Créer' }).click();
  await expect(page.getByTestId('folder')).toHaveText(/Juin 2026/);

  const row = page.getByTestId('track-row').filter({ hasText: 'ref02 90 Cmaj' });
  await row.getByLabel('Actions ref02 90 Cmaj').click();
  await row.getByRole('button', { name: 'Déplacer' }).click();
  await page.getByTestId('move-dialog').getByRole('button', { name: /Juin 2026/ }).click();
  await expect(page.getByTestId('track-row')).toHaveCount(1);

  await page.getByTestId('folder').getByRole('link').click();
  await expect(page.getByTestId('track-row')).toHaveText(/ref02 90 Cmaj/);
  await page.goto('/app');
  await page.getByLabel('Actions Juin 2026').click();
  await page.getByTestId('delete-folder').click();
  await expect(page.getByTestId('folder')).toHaveCount(0);
  await expect(page.getByTestId('track-row')).toHaveCount(2);

  await page.getByLabel('BPM minimum').fill('100');
  await page.getByRole('button', { name: 'Filtrer' }).click();
  await expect(page.getByTestId('track-row')).toHaveCount(1);
  await expect(page.getByTestId('track-row')).toContainText('ref07 120 Emin');
});

test('un fichier qui n’est pas de l’audio est refusé avec un message clair', async ({ page }) => {
  await signUp(page);
  await page.getByTestId('file-input').setInputFiles({ name: 'faux.wav', mimeType: 'audio/wav', buffer: Buffer.from('pas du son') });
  await expect(page.getByTestId('track-row')).toContainText('pas un fichier audio', { timeout: 30_000 });
});
