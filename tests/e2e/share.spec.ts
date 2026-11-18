import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { fixture, readCode, signUp } from './helpers';

/** Connexion par code sur la page de connexion déjà ouverte (garde la destination « next »). */
async function loginHere(page: Page, email: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Recevoir un code' }).click();
  await page.getByLabel('Code à 6 chiffres').fill(await readCode(email));
  await page.getByRole('button', { name: 'Se connecter' }).click();
}

/** Envoie deux beats, crée un projet « Pack » qui les contient ; le second est mis en privé. */
async function ownerWithProject(page: Page) {
  await signUp(page);
  await page.getByTestId('file-input').setInputFiles([fixture('ref02_90_Cmaj.mp3'), fixture('ref06_100_Gmin.mp3')]);
  await expect(page.getByTestId('track-row')).toHaveCount(2);
  await expect(page.getByTestId('track-row').filter({ hasText: 'BPM' })).toHaveCount(2, { timeout: 60_000 });
  const lib = await (await page.request.get('/api/library')).json();
  const byTitle = Object.fromEntries(lib.tracks.map((t: { title: string; id: string }) => [t.title, t.id]));
  const open = byTitle['ref02 90 Cmaj'];
  const secret = byTitle['ref06 100 Gmin'];
  const project = await (await page.request.post('/api/projects', { data: { title: 'Pack été' } })).json();
  await page.request.post(`/api/projects/${project.id}/tracks`, { data: { trackIds: [open, secret] } });
  await page.request.patch(`/api/share/track/${secret}`, { data: { visibility: 'private' } });
  await page.goto(`/app/projects/${project.id}`);
  await page.getByTestId('share').click();
  return { projectId: project.id as string };
}

async function createLink(page: Page, name: string) {
  await page.getByPlaceholder('Nom du lien').fill(name);
  await page.getByTestId('create-link').click();
  const row = page.getByTestId('link-row').filter({ hasText: name });
  await expect(row).toBeVisible();
  return (await row.getAttribute('data-url'))!;
}

test('partage public : morceau privé masqué, écoute, mot de passe, révocation', async ({ page, browser }) => {
  await ownerWithProject(page);
  await page.getByTestId('vis-public').check();
  const url = await createLink(page, 'Instagram');

  const listener = await (await browser.newContext({ viewport: { width: 375, height: 800 } })).newPage();
  await listener.goto(url);
  await expect(listener.getByTestId('shared-title')).toHaveText('Pack été');
  await expect(listener.getByTestId('shared-track')).toHaveCount(1);
  await expect(listener.getByTestId('shared-track')).toContainText('ref02 90 Cmaj');
  await expect(listener.getByTestId('tracking-notice')).toBeVisible();
  await listener.screenshot({ path: 'test-results/share-mobile.png', fullPage: true });
  const overflow = await listener.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await listener.getByRole('button', { name: /Écouter ref02 90 Cmaj/ }).click();
  await expect.poll(() => listener.evaluate(() => document.querySelector('audio')?.currentTime ?? 0), { timeout: 15_000 }).toBeGreaterThan(0.5);
  // Pas de téléchargement tant que le propriétaire ne l'autorise pas.
  await expect(listener.getByRole('link', { name: /Télécharger/ })).toHaveCount(0);

  // Mot de passe.
  await page.getByPlaceholder('Optionnel').fill('pack2026');
  await page.getByRole('button', { name: 'Protéger' }).click();
  await expect(page.getByText('· actif')).toBeVisible();
  await listener.reload();
  await expect(listener.getByRole('heading', { name: 'Partage protégé' })).toBeVisible();
  await listener.getByLabel('Mot de passe').fill('mauvais');
  await listener.getByRole('button', { name: 'Accéder' }).click();
  await expect(listener.locator('p[role=alert]')).toHaveText('Mot de passe incorrect.');
  await listener.getByLabel('Mot de passe').fill('pack2026');
  await listener.getByRole('button', { name: 'Accéder' }).click();
  await expect(listener.getByTestId('shared-title')).toHaveText('Pack été');

  // Révocation : la page et l'audio deviennent introuvables.
  const audioSrc = await listener.evaluate(() => document.querySelector('audio')?.getAttribute('src') ?? '');
  await page.getByTestId('link-row').filter({ hasText: 'Instagram' }).getByRole('button', { name: 'Révoquer' }).click();
  await expect(page.getByTestId('link-row')).toHaveCount(0);
  const res = await listener.goto(url);
  expect(res?.status()).toBe(404);
  if (audioSrc) expect((await listener.request.get(audioSrc)).status()).toBe(404);
});

test('partage sur invitation : connexion exigée, autre adresse refusée, invité accepté', async ({ page, browser }) => {
  await ownerWithProject(page);
  await page.getByTestId('vis-invite').check();
  const guest = `invite_${randomUUID().slice(0, 8)}@test.local`;
  await page.getByLabel('Adresse à inviter').fill(guest);
  await page.getByRole('button', { name: 'Inviter' }).click();
  await expect(page.getByTestId('invites')).toContainText(guest);

  // Le lien arrive par email.
  const dir = path.resolve('.data/e2e/mail');
  let url = '';
  for (let i = 0; i < 40 && !url; i++) {
    for (const f of await readdir(dir)) {
      const m = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
      if (m.to === guest && m.tag === 'invite') url = /(http\S+\/s\/\S+)/.exec(m.text)![1];
    }
    if (!url) await new Promise((r) => setTimeout(r, 250));
  }
  expect(url).toContain('/s/');

  const ctx = await browser.newContext();
  const g = await ctx.newPage();
  await g.goto(url);
  await g.getByRole('link', { name: 'Se connecter pour écouter' }).click();
  // Une autre adresse : refusée.
  const intruder = `autre_${randomUUID().slice(0, 8)}@test.local`;
  await loginHere(g, intruder);
  await expect(g.getByRole('heading', { name: 'Partage réservé aux invités' })).toBeVisible();
  await g.getByRole('button', { name: 'Me connecter avec une autre adresse' }).click();
  await expect(g).toHaveURL(/\/login\?next=/);
  // L'adresse invitée : accès direct au partage, sans créer de profil de producteur.
  await loginHere(g, guest);
  await expect(g.getByTestId('shared-title')).toHaveText('Pack été');
  await expect(g.getByTestId('shared-track')).toHaveCount(1);
});
