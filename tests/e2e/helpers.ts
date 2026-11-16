import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

const MAIL_DIR = path.resolve('.data/e2e/mail');

export async function readCode(email: string) {
  for (let i = 0; i < 40; i++) {
    const files = (await readdir(MAIL_DIR).catch(() => [] as string[])).sort().reverse();
    for (const f of files) {
      const m = JSON.parse(await readFile(path.join(MAIL_DIR, f), 'utf8'));
      if (m.to === email && m.tag === 'login_code') return /(\d{6})/.exec(m.subject)![1];
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`pas de code pour ${email}`);
}

export async function login(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Recevoir un code' }).click();
  await expect(page.getByLabel('Code à 6 chiffres')).toBeVisible();
  await page.getByLabel('Code à 6 chiffres').fill(await readCode(email));
  await page.getByRole('button', { name: 'Se connecter' }).click();
}

/** Crée un compte complet (code + profil) et arrive sur la bibliothèque. */
export async function signUp(page: Page) {
  const id = randomUUID().slice(0, 8);
  const email = `e2e_${id}@test.local`;
  await login(page, email);
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel('Nom d’artiste').fill(`Prod ${id}`);
  await page.getByLabel('Identifiant').fill(`prod_${id}`);
  await page.getByRole('button', { name: 'Créer mon profil' }).click();
  await expect(page).toHaveURL(/\/app$/);
  return { email, handle: `prod_${id}` };
}

export const fixture = (name: string) => path.resolve('tests/fixtures/generated', name);
