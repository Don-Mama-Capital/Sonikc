import { expect, test } from '@playwright/test';
import { login, signUp } from './helpers';

test('inscription par code email, profil, déconnexion, reconnexion', async ({ page }) => {
  const { email, handle } = await signUp(page);
  await expect(page.getByTestId('me')).toHaveText(`@${handle}`);
  await page.getByTestId('logout').click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/app');
  await expect(page).toHaveURL(/\/login/);
  await login(page, email);
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByTestId('me')).toHaveText(`@${handle}`);
});

test('un mauvais code affiche une erreur lisible', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(`wrong_${Date.now()}@test.local`);
  await page.getByRole('button', { name: 'Recevoir un code' }).click();
  await page.getByLabel('Code à 6 chiffres').fill('000000');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.locator('p[role=alert]')).toContainText(/Code incorrect|Code invalide/);
});

test('un identifiant déjà pris est refusé à l’onboarding', async ({ page, browser }) => {
  const { handle } = await signUp(page);
  const other = await browser.newPage();
  await login(other, `other_${Date.now()}@test.local`);
  await expect(other).toHaveURL(/\/onboarding/);
  await other.getByLabel('Nom d’artiste').fill('Autre');
  await other.getByLabel('Identifiant').fill(handle);
  await other.getByRole('button', { name: 'Créer mon profil' }).click();
  await expect(other.locator('p[role=alert]')).toContainText('déjà pris');
});
