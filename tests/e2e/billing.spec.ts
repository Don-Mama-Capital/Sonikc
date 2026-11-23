import { expect, test } from '@playwright/test';
import { signUp } from './helpers';

test('offres : tarifs générés, limite de l’offre gratuite, abonnement avec essai, changement d’offre au portail', async ({ page }) => {
  // Page tarifs publique, à 375 px.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/tarifs');
  await expect(page.getByTestId('offers').locator('section')).toHaveCount(3);
  await page.getByRole('radio', { name: 'À l’année' }).click();
  await expect(page.getByTestId('compare')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: 'test-results/tarifs-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });

  // Compte en offre gratuite.
  await signUp(page, 'free');
  await page.goto('/app/offre');
  await expect(page.getByTestId('meter').first()).toContainText('0 / 25');
  const freeName = await page.getByTestId('offer-name').innerText();

  // Abonnement : depuis la carte de l'offre du milieu, essai sans carte, retour sur « Mon offre ».
  await page.getByTestId('offers').locator('section').nth(1).getByRole('link').click();
  await expect(page.getByTestId('subscribe')).toBeVisible();
  await page.getByTestId('subscribe-go').click();
  await expect(page.getByRole('heading', { name: /Faux paiement Stripe/ })).toBeVisible();
  await page.getByRole('button', { name: 'Payer' }).click();
  await expect(page).toHaveURL(/\/app\/offre\?abonnement=ok/);
  await expect(page.getByTestId('offer-name')).not.toHaveText(freeName, { timeout: 30_000 });
  const paidName = await page.getByTestId('offer-name').innerText();
  await expect(page.getByTestId('sub-status')).toContainText('Essai gratuit');
  await page.screenshot({ path: 'test-results/mon-offre.png', fullPage: true });

  // Portail : passer à l'offre supérieure à l'année.
  await page.getByTestId('portal').click();
  await page.getByRole('button', { name: /sonikc_studio_year/ }).click();
  await expect(page).toHaveURL(/\/app\/offre/);
  await expect(page.getByTestId('offer-name')).not.toHaveText(paidName, { timeout: 30_000 });
});
