import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('« Continuer avec Google » : compte créé puis profil, et reconnu au retour', async ({ page }) => {
  const email = `g_${randomUUID().slice(0, 8)}@gmail.com`;
  await page.goto('/login');
  await page.getByRole('link', { name: 'Continuer avec Google' }).click();
  await expect(page.getByRole('heading', { name: 'Faux Google' })).toBeVisible();
  await page.getByLabel('Adresse Google').fill(email);
  await page.getByRole('button', { name: 'Continuer' }).click();
  await expect(page).toHaveURL(/\/onboarding/);
  const id = randomUUID().slice(0, 8);
  await page.getByLabel('Nom d’artiste').fill(`G ${id}`);
  await page.getByLabel('Identifiant').fill(`g_${id}`);
  await page.getByRole('button', { name: 'Créer mon profil' }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.context().clearCookies();
  await page.goto('/login');
  await page.getByRole('link', { name: 'Continuer avec Google' }).click();
  await page.getByLabel('Adresse Google').fill(email);
  await page.getByRole('button', { name: 'Continuer' }).click();
  await expect(page).toHaveURL(/\/app$/);
});

test('adresse Google non vérifiée : message clair, pas de session', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Continuer avec Google' }).click();
  await page.getByLabel('Adresse Google').fill(`u_${randomUUID().slice(0, 8)}@gmail.com`);
  await page.getByLabel('Adresse non vérifiée').check();
  await page.getByRole('button', { name: 'Continuer' }).click();
  await expect(page).toHaveURL(/\/login\?error=google_email_unverified/);
  await expect(page.locator('p[role=alert]')).toContainText('pas vérifiée');
  await page.goto('/app');
  await expect(page).toHaveURL(/\/login/);
});
