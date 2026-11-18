import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { fixture, signUp } from './helpers';

async function campaignMailTo(email: string) {
  const dir = path.resolve('.data/e2e/mail');
  for (let i = 0; i < 80; i++) {
    for (const f of await readdir(dir)) {
      const m = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
      if (m.to === email && m.tag === 'campaign') return m as { subject: string; text: string; html: string };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`aucun email pour ${email}`);
}

test('emailing : composer, envoyer, email reçu, écoute du destinataire visible avec son nom, désinscription', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await signUp(page);
  await page.getByTestId('file-input').setInputFiles(fixture('ref02_90_Cmaj.mp3'));
  await expect(page.getByTestId('track-row').filter({ hasText: 'BPM' })).toHaveCount(1, { timeout: 60_000 });
  const lib = await (await page.request.get('/api/library')).json();
  const trackId = lib.tracks[0].id as string;
  const email = `ar_${randomUUID().slice(0, 8)}@label.fr`;
  await page.request.post('/api/contacts', { data: { email, name: 'Inès Label' } });

  await page.goto(`/app/tracks/${trackId}`);
  await page.getByTestId('send-email').click();
  // Partage privé : bloqué avec une explication.
  await expect(page.locator('p[role=alert]')).toContainText('Ce partage est privé');
  await page.request.patch(`/api/share/track/${trackId}`, { data: { visibility: 'public' } });
  await page.reload();
  await page.getByLabel('Objet', { exact: true }).fill('Un beat pour {prenom}');
  await page.getByRole('button', { name: 'Envoyer' }).click();
  await expect(page).toHaveURL(/\/app\/campaigns\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('campaign-status')).toHaveText('Envoyé', { timeout: 20_000 });

  const mail = await campaignMailTo(email);
  expect(mail.subject).toBe('Un beat pour Inès');
  const click = /(http\S+\/e\/c\/[A-Za-z0-9_-]{44})/.exec(mail.text)![1];

  const dest = await (await browser.newContext()).newPage();
  await dest.goto(click);
  await expect(dest).toHaveURL(/\/s\/[A-Za-z0-9_-]{44}$/);
  await dest.getByRole('button', { name: /^Écouter / }).click();
  await expect.poll(() => dest.evaluate(() => document.querySelector('audio')?.currentTime ?? 0), { timeout: 20_000 }).toBeGreaterThan(6);
  await dest.getByRole('button', { name: /^Pause / }).click();

  await page.reload();
  await expect(page.getByTestId('campaign-clicked')).toHaveText('1');
  await expect(page.getByTestId('campaign-listened')).toHaveText('1', { timeout: 15_000 });
  await expect(page.getByTestId('recipient')).toContainText('Inès Label');
  await expect(page.getByTestId('recipient-listened')).toBeVisible();
  await page.screenshot({ path: 'test-results/campaign.png', fullPage: true });
  await page.goto(`/app/tracks/${trackId}`);
  await expect(page.getByTestId('recent-listen').first()).toContainText('Inès Label');

  // Désinscription en un clic depuis le lien de l'email.
  const unsub = /(http\S+\/e\/u\/[A-Za-z0-9_-]{44})/.exec(mail.text)![1];
  await dest.goto(unsub);
  await dest.getByRole('button', { name: 'Me désinscrire' }).click();
  await expect(dest.getByTestId('unsub-done')).toBeVisible();
  await page.goto('/app/contacts');
  await expect(page.getByTestId('contact-row')).toContainText('désinscrit');
});
