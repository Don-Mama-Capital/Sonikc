import { expect, test } from '@playwright/test';
import { signUp } from './helpers';

test('contacts : import CSV avec doublons, recherche, groupe à règle, fiche, à 375 px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await signUp(page);
  await page.goto('/app/contacts');
  await page.getByRole('button', { name: 'Importer' }).click();
  const csv = ['Nom;Email;Tags', 'Léa Martin;lea@label.fr;a&r|rap', 'Bob;bob@studio.fr;ingé', ';LEA@label.fr;drill', 'Cassé;pas-une-adresse;'].join('\n');
  await page.getByTestId('csv-input').setInputFiles({ name: 'contacts.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByTestId('import-result')).toContainText('2 contacts ajoutés, 1 fusionné, 1 ligne ignorée');
  await expect(page.getByTestId('contact-row')).toHaveCount(2);
  await expect(page.getByTestId('contacts-total')).toHaveText('2');

  await page.getByLabel('Rechercher').fill('studio');
  await expect(page.getByTestId('contact-row')).toHaveCount(1);
  await page.getByLabel('Rechercher').fill('');

  await page.getByRole('button', { name: 'Nouveau groupe' }).click();
  await page.getByPlaceholder('Nom du groupe').fill('Rap');
  await page.getByLabel('Règle').selectOption('tag');
  await page.getByPlaceholder('tag').fill('rap');
  await page.getByRole('button', { name: 'Créer' }).click();
  await page.getByTestId('group-chip').filter({ hasText: 'Rap' }).click();
  await expect(page.getByTestId('contact-row')).toHaveCount(1);
  await expect(page.getByTestId('contact-row')).toContainText('Léa Martin');
  await expect(page.getByTestId('contact-row')).toContainText('drill');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: 'test-results/contacts-mobile.png', fullPage: true });

  await page.getByTestId('contact-row').click();
  await expect(page.getByTestId('contact-name')).toHaveText('Léa Martin');
  await expect(page.getByTestId('contact-score')).toHaveText('0');
  const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow2).toBeLessThanOrEqual(0);
});
