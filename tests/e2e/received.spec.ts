import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { fixture, readCode, signUp } from './helpers';

test('Reçus : un auditeur sans profil enregistre un partage, le réécoute depuis Reçus ; le producteur est prévenu', async ({ page, browser }) => {
  await signUp(page);
  await page.getByTestId('file-input').setInputFiles(fixture('ref02_90_Cmaj.mp3'));
  await expect(page.getByTestId('track-row').filter({ hasText: 'BPM' })).toHaveCount(1, { timeout: 60_000 });
  const lib = await (await page.request.get('/api/library')).json();
  const project = await (await page.request.post('/api/projects', { data: { title: 'Pack hiver' } })).json();
  await page.request.post(`/api/projects/${project.id}/tracks`, { data: { trackIds: [lib.tracks[0].id] } });
  await page.request.patch(`/api/share/project/${project.id}`, { data: { visibility: 'public' } });
  const link = await (await page.request.post(`/api/share/project/${project.id}/links`, { data: { label: 'Mail A&R' } })).json();
  await page.goto(`/app/projects/${project.id}`);

  const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const ar = await ctx.newPage();
  await ar.goto(link.url);
  // Anonyme : on l'invite à se connecter ; il revient sur le partage, sans créer de profil de producteur.
  await ar.getByRole('link', { name: 'Se connecter pour enregistrer' }).click();
  const email = `ar_${randomUUID().slice(0, 8)}@test.local`;
  await ar.getByLabel('Email').fill(email);
  await ar.getByRole('button', { name: 'Recevoir un code' }).click();
  await ar.getByLabel('Code à 6 chiffres').fill(await readCode(email));
  await ar.getByRole('button', { name: 'Se connecter' }).click();
  await expect(ar.getByTestId('shared-title')).toHaveText('Pack hiver');
  await ar.getByTestId('save').click();
  await expect(ar.getByTestId('save')).toHaveText('✓ Enregistré dans mes reçus');

  // Le producteur est prévenu.
  await expect(page.getByTestId('bell-count')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('bell').click();
  await expect(page.getByTestId('notification').first()).toContainText('a enregistré « Pack hiver »');

  // Reçus : écoutable sans le lien, à 375 px sans débordement.
  await ar.getByRole('link', { name: 'Mes reçus' }).click();
  await expect(ar).toHaveURL(/\/recus$/);
  await expect(ar.getByTestId('received-title')).toHaveText('Pack hiver');
  await ar.getByRole('button', { name: /^Écouter / }).click();
  await expect.poll(() => ar.evaluate(() => document.querySelector('audio')?.currentTime ?? 0), { timeout: 15_000 }).toBeGreaterThan(0.5);
  const overflow = await ar.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await ar.screenshot({ path: 'test-results/recus-mobile.png', fullPage: true });

  // Le producteur repasse le projet en privé : indisponible dans Reçus.
  await page.request.patch(`/api/share/project/${project.id}`, { data: { visibility: 'private' } });
  await ar.reload();
  await expect(ar.getByTestId('received-item')).toHaveAttribute('data-available', 'false');
  await expect(ar.getByTestId('received-item')).toContainText('n’est plus disponible');
});
