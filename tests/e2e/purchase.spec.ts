import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { fixture, signUp } from './helpers';

test('achat de bout en bout (faux Stripe) : licence, paiement, fichiers, certificat, vente, remboursement', async ({ page, browser }) => {
  const { handle } = await signUp(page);
  await page.getByTestId('file-input').setInputFiles([fixture('ref01_140_Amin.wav')]);
  await expect(page.getByTestId('track-row').filter({ hasText: 'BPM' })).toHaveCount(1, { timeout: 60_000 });
  const lib = await (await page.request.get('/api/library')).json();
  const trackId = lib.tracks[0].id as string;

  // Mise en vente depuis le panneau de partage, avec un collaborateur.
  const collab = await (await browser.newContext()).newPage();
  const { handle: collabHandle } = await signUp(collab);
  await page.goto(`/app/tracks/${trackId}`);
  await page.getByTestId('share').click();
  await page.getByTestId('vis-for_sale').check();
  await expect(page.getByTestId('track-licences')).toBeVisible();
  await page.getByLabel('Identifiant Sonikc du collaborateur').fill(`@${collabHandle}`);
  await page.getByLabel('Part en %').fill('25');
  await page.getByTestId('track-splits').getByRole('button', { name: 'Ajouter' }).click();
  await expect(page.getByTestId('split-status')).toContainText('en attente de son accord');
  await expect(page.getByTestId('my-pct')).toHaveText('100 %');
  // Le collaborateur accepte depuis « Ventes ».
  await collab.goto('/app/ventes');
  await collab.getByTestId('collab').getByTestId('accept').click();
  await expect(collab.getByTestId('collab')).toContainText('acceptée');
  await page.reload();
  await page.getByTestId('share').click();
  await expect(page.getByTestId('my-pct')).toHaveText('75 %');

  // L'acheteur, sans compte, sur mobile.
  const buyer = await (await browser.newContext({ viewport: { width: 375, height: 800 } })).newPage();
  await buyer.goto(`/${handle}`);
  await buyer.getByText('Voir les licences').click();
  await buyer.getByTestId('licence').filter({ hasText: 'Premium' }).getByTestId('buy').click();
  await buyer.getByLabel('Ton email (fichiers et facture)').fill('acheteur@client.fr');
  await buyer.getByLabel('Ton pays (pour la TVA)').selectOption('BE');
  await buyer.getByRole('button', { name: 'Payer' }).click();
  // Page de paiement (faux Stripe) : 59 € HT + TVA belge 21 % = 71,39 €.
  await expect(buyer.getByTestId('fake-total')).toHaveText('71.39 €');
  await buyer.getByLabel('Pays de la carte').selectOption('BE');
  await buyer.getByRole('button', { name: 'Payer' }).click();
  await expect(buyer).toHaveURL(/\/commande\//);
  await expect(buyer.getByTestId('order-title')).toHaveText('ref01 140 Amin', { timeout: 20_000 });
  await expect(buyer.getByTestId('file-wav')).toBeVisible({ timeout: 30_000 });
  await expect(buyer.getByTestId('file-mp3')).toBeVisible();
  await expect(buyer.getByTestId('file-licence')).toBeVisible();
  await expect(buyer.getByTestId('file-invoice')).toBeVisible();
  await buyer.screenshot({ path: 'test-results/order-mobile.png', fullPage: true });
  const overflow = await buyer.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // Le fichier téléchargé a l'empreinte inscrite sur le certificat.
  const href = await buyer.getByTestId('file-wav').getAttribute('href');
  const body = await (await buyer.request.get(href!)).body();
  const hash = createHash('sha256').update(body).digest('hex');
  await expect(buyer.getByTestId('certificate')).toContainText(hash);
  const pdf = await (await buyer.request.get((await buyer.getByTestId('file-licence').getAttribute('href'))!)).body();
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  // Un lien de fichier modifié est refusé.
  expect((await buyer.request.get(href!.replace(/sig=[^&]+/, 'sig=faux'))).status()).toBe(403);

  // Côté producteur : la vente, sa part (75 %), reversements à activer, puis remboursement.
  await page.goto('/app/ventes');
  await expect(page.getByTestId('sale')).toHaveCount(1);
  await expect(page.getByTestId('sale')).toContainText('Premium');
  await expect(page.getByTestId('payouts-status')).toContainText('Pas encore activés');
  await page.getByTestId('onboard').click();
  await page.getByRole('button', { name: 'Valider mes informations' }).click();
  await expect(page).toHaveURL(/\/app\/ventes\?connect=retour/);
  await expect(page.getByTestId('payouts-status')).toContainText('Actifs');
  await page.screenshot({ path: 'test-results/sales.png', fullPage: true });
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('refund').click();
  await expect(page.getByTestId('share-status')).toContainText('Remboursée');

  // L'acheteur voit le remboursement ; les fichiers audio ne sont plus servis, l'avoir arrive.
  await buyer.reload();
  await expect(buyer.getByTestId('order-refunded')).toBeVisible();
  await expect(buyer.getByTestId('file-wav')).toHaveCount(0);
  await expect(buyer.getByTestId('file-credit_note')).toBeVisible({ timeout: 20_000 });
  expect((await buyer.request.get(href!)).status()).toBe(404);
});
