import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { a11y, deleteAccount, expect, shot, signUp, test } from './kit';

/** Import de contacts (CSV) ; rend le texte affiché (résultat ou message d'erreur). */
async function importContacts(page: Page, n: number, tag: string) {
  await page.goto('/app/contacts');
  await page.getByRole('button', { name: 'Importer' }).click();
  const rows = ['Nom;Email'];
  for (let i = 0; i < n; i++) rows.push(`Contact ${i};c${i}.${tag}@exemple.fr`);
  await page.getByTestId('csv-input').setInputFiles({ name: 'contacts.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n')) });
}

async function subscribe(page: Page) {
  await page.goto('/app/offre');
  await page.getByTestId('offers').locator('section').nth(1).getByRole('link').click();
  await page.getByTestId('subscribe-go').click();
  await page.getByRole('button', { name: 'Payer' }).click();
  await expect(page).toHaveURL(/\/app\/offre\?abonnement=ok/);
  await expect(page.getByTestId('sub-status')).toBeVisible({ timeout: 30_000 });
}

/** R5 + R6 (export) : Nora, offre gratuite, atteint une limite, essaie Pro, résilie ; l'essai ne se reprend pas. */
test('R5-R6 Nora : limite claire, essai Pro, limite levée, résiliation, export, pas de second essai', async ({ persona }) => {
  const tag = randomUUID().slice(0, 6);
  const nora = await persona('Nora');
  const p = nora.page;
  const me = await signUp(p, 'Nora', { email: `nora.recette.${tag}@gmail.com` });

  // Offre gratuite : 100 contacts au plus. 101 d'un coup : refusé, avec l'offre qui lève la limite.
  await importContacts(p, 101, tag);
  await expect(p.getByText(/Limite de ton offre .* Passe à l’offre/)).toBeVisible();
  await shot(p, 'R5-limite-contacts');

  // Essai de l'offre Pro, sans carte.
  await subscribe(p);
  await expect(p.getByTestId('sub-status')).toContainText('Essai gratuit');
  await a11y(p, 'mon-offre');
  await shot(p, 'R5-mon-offre-essai');
  await importContacts(p, 101, tag);
  await expect(p.getByTestId('import-result')).toContainText('101 contacts ajoutés');

  // Résiliation au portail : comme chez Stripe, l'offre reste jusqu'à la fin de la période (ici de l'essai), et la page le dit.
  await p.goto('/app/offre');
  await p.getByTestId('portal').click();
  await p.getByRole('button', { name: 'Résilier' }).click();
  await expect(p).toHaveURL(/\/app\/offre/);
  await expect(p.getByTestId('sub-status')).toContainText('pas de renouvellement', { timeout: 30_000 });
  await expect(p.getByTestId('meter').filter({ hasText: /contacts/i })).toContainText('101 / 5 000');
  await shot(p, 'R5-resiliation');

  // Export de toutes ses données.
  await p.goto('/compte');
  const dl = p.waitForEvent('download');
  await p.getByTestId('export').click();
  const data = JSON.parse(await readFile((await (await dl).path())!, 'utf8'));
  expect(data.contacts).toHaveLength(101);
  expect(data.compte.email).toBe(me.email);
  expect(data.abonnement[0].essai_utilise).toBe(true);
  await a11y(p, 'mes-donnees');

  // Nora supprime son compte puis revient avec la même adresse écrite autrement : pas de second essai.
  await deleteAccount(p);
  const back = await persona('Nora revient');
  await signUp(back.page, 'Nora', { email: `norarecette${tag}+retour@googlemail.com` });
  await subscribe(back.page);
  await expect(back.page.getByTestId('sub-status')).not.toContainText('Essai');
  await deleteAccount(back.page);
});
