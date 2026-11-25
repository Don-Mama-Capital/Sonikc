import type { Page } from '@playwright/test';
import { a11y, address, deleteAccount, expect, fixture, listen, mail, mails, reel, shot, signUp, test, trackIds, upload } from './kit';

/**
 * Paiement d'une commande. Local : faux Stripe. Réel : page Stripe Checkout en mode test, carte de test 4242.
 * Rend false si Stripe affiche une vérification anti-robot (paiement alors « non vérifiable automatiquement »).
 */
async function pay(page: Page, cardCountry = 'FR') {
  if (!reel()) {
    await page.getByLabel('Pays de la carte').selectOption(cardCountry);
    await page.getByRole('button', { name: 'Payer' }).click();
    return true;
  }
  await page.waitForURL(/checkout\.stripe\.com/, { timeout: 60_000 });
  await page.locator('#cardNumber').fill('4242 4242 4242 4242');
  await page.locator('#cardExpiry').fill('12 / 34');
  await page.locator('#cardCvc').fill('123');
  const name = page.locator('#billingName');
  if (await name.isVisible().catch(() => false)) await name.fill('Jules Recette');
  const zip = page.locator('#billingPostalCode');
  if (await zip.isVisible().catch(() => false)) await zip.fill('75011');
  await page.locator('[data-testid="hosted-payment-submit-button"]').click();
  const done = await Promise.race([
    page.waitForURL(/\/commande\//, { timeout: 90_000 }).then(() => true),
    page.locator('iframe[src*="hcaptcha"]').first().waitFor({ timeout: 90_000 }).then(() => false),
  ]);
  if (!done) test.info().annotations.push({ type: 'non vérifiable', description: 'Stripe a demandé une vérification anti-robot : paiement réel non vérifiable automatiquement.' });
  return done;
}

async function chooseGroup(page: Page, name: string) {
  const select = page.getByLabel('Destinataires');
  await select.selectOption((await select.locator('option', { hasText: name }).getAttribute('value'))!);
}

test('@reel R3-R4 Max : envois avec désinscription, vente avec collaborateur, achats simultanés, exclusive, remboursement', async ({ persona }) => {
  const max = await persona('Max');
  const sami = await persona('Sami');
  const p = max.page;
  const [me, sam] = await Promise.all([signUp(p, 'Max', { plan: 'studio' }), signUp(sami.page, 'Sami')]);
  await upload(p, [fixture('ref09_150_C#min.wav'), fixture('ref05_160_Ebmaj.wav')], 2, 180_000);
  const ids = await trackIds(p);
  const beatA = ids['ref09 150 C#min'];
  const beatB = ids['ref05 160 Ebmaj'];

  // R3 — contacts, groupe, envoi avec relance (le niveau réel l'envoie aussi : emails dans la boîte locale).
  const lea = address('Lea');
  const bob = address('Bob');
  await p.goto('/app/contacts');
  await p.getByRole('button', { name: 'Importer' }).click();
  const csv = ['Nom;Email;Tags', `Léa Martin;${lea};a&r`, `Bob Studio;${bob};a&r`, 'Sans adresse;pas-une-adresse;'].join('\n');
  await p.getByTestId('csv-input').setInputFiles({ name: 'contacts.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(p.getByTestId('import-result')).toContainText('2 contacts ajoutés');
  await p.getByRole('button', { name: 'Nouveau groupe' }).click();
  await p.getByPlaceholder('Nom du groupe').fill('A&R');
  await p.getByLabel('Règle').selectOption('tag');
  await p.getByPlaceholder('tag').fill('a&r');
  await p.getByRole('button', { name: 'Créer' }).click();
  await a11y(p, 'contacts');

  await p.request.patch(`/api/share/track/${beatA}`, { data: { visibility: 'public' } });
  await p.goto(`/app/tracks/${beatA}`);
  await p.getByTestId('send-email').click();
  await chooseGroup(p, 'A&R');
  await p.getByLabel('Objet', { exact: true }).fill('Un beat pour {prenom}');
  // La relance est cochée par défaut : on vérifie qu'elle l'est (sans la décocher).
  await expect(p.getByRole('checkbox', { name: /Relancer ceux qui n’ont ni écouté/ })).toBeChecked();
  await a11y(p, 'nouvel-envoi');
  await p.getByRole('button', { name: 'Envoyer' }).click();
  await expect(p).toHaveURL(/\/app\/campaigns\/[0-9a-f-]{36}$/);
  await expect(p.getByTestId('campaign-status')).toHaveText('Envoyé', { timeout: 60_000 });
  await expect(p.getByTestId('campaign-sent')).toHaveText('2/2');

  // Léa ouvre l'email, écoute, puis se désinscrit ; Bob ne fait rien (sa relance reste prévue).
  const m = await mail(lea, 'campaign');
  expect(m.subject).toBe('Un beat pour Léa');
  const dest = await persona('Léa');
  await dest.page.goto(/(http\S+\/e\/c\/[A-Za-z0-9_-]{44})/.exec(m.text)![1]);
  await dest.page.getByTestId('consent-refuse').click();
  await listen(dest.page, /^Écouter /, 7);
  await dest.page.goto(/(http\S+\/e\/u\/[A-Za-z0-9_-]{44})/.exec(m.text)![1]);
  await dest.page.getByRole('button', { name: 'Me désinscrire' }).click();
  await expect(dest.page.getByTestId('unsub-done')).toBeVisible();
  await p.reload();
  await expect(p.getByTestId('campaign-clicked')).toHaveText('1');
  await expect(p.getByTestId('campaign-listened')).toHaveText('1', { timeout: 20_000 });
  // La relance reste prévue pour Bob (ni écouté, ni cliqué) : elle partira dans 3 jours.
  await expect(p.getByRole('button', { name: /Annuler la relance/ })).toBeVisible();
  await shot(p, 'R3-envoi');

  // Second envoi au groupe : Léa, désinscrite, ne reçoit rien ; Bob reçoit.
  await p.goto(`/app/tracks/${beatA}`);
  await p.getByTestId('send-email').click();
  await chooseGroup(p, 'A&R');
  await p.getByLabel('Objet', { exact: true }).fill('Encore un');
  await p.getByRole('button', { name: 'Envoyer' }).click();
  await expect(p.getByTestId('campaign-status')).toHaveText('Envoyé', { timeout: 60_000 });
  await mail(bob, 'campaign', { match: /./ });
  await expect.poll(async () => (await mails(bob, 'campaign')).length, { timeout: 30_000 }).toBe(2);
  expect((await mails(lea, 'campaign')).length).toBe(1);

  // R4 — mise en vente des deux beats ; Sami a 30 % sur le beat B, qu'il accepte.
  for (const id of [beatA, beatB]) await p.request.patch(`/api/share/track/${id}`, { data: { visibility: 'for_sale' } });
  await p.goto('/app/boutique');
  await expect(p.getByTestId('template')).toHaveCount(3);
  await a11y(p, 'ma-page');
  await p.goto(`/app/tracks/${beatB}`);
  await p.getByTestId('share').click();
  await expect(p.getByTestId('track-licences')).toBeVisible();
  await p.getByLabel('Identifiant Sonikc du collaborateur').fill(`@${sam.handle}`);
  await p.getByLabel('Part en %').fill('30');
  await p.getByTestId('track-splits').getByRole('button', { name: 'Ajouter' }).click();
  await expect(p.getByTestId('split-status')).toContainText('en attente de son accord');
  await sami.page.goto('/app/ventes');
  await sami.page.getByTestId('collab').getByTestId('accept').click();
  await expect(sami.page.getByTestId('collab')).toContainText('en vigueur : 30 %');

  // Deux acheteurs en même temps : Jules prend la licence Premium du beat A, Jade l'exclusive du beat B.
  const [jules, jade] = [await persona('Jules', { viewport: { width: 375, height: 812 } }), await persona('Jade')];
  const julesMail = address('Jules');
  const jadeMail = address('Jade');
  const buy = async (who: typeof jules, email: string, track: string, licence: RegExp) => {
    await who.page.goto(`/${me.handle}`);
    await who.page.getByTestId('consent-refuse').click();
    await who.page.getByTestId('store-track').filter({ hasText: track }).getByText('Voir les licences').click();
    await who.page.getByTestId('licence').filter({ hasText: licence }).getByTestId('buy').click();
    await who.page.getByLabel('Ton email (fichiers et facture)').fill(email);
    await who.page.getByLabel('Ton pays (pour la TVA)').selectOption('FR');
    // Sans la case de renonciation, le paiement est impossible.
    await who.page.getByRole('button', { name: 'Payer' }).click();
    await expect(who.page.getByTestId('waiver')).toBeFocused();
    await who.page.getByTestId('waiver').check();
    await who.page.getByRole('button', { name: 'Payer' }).click();
    return pay(who.page);
  };
  const [paidA, paidB] = await Promise.all([
    buy(jules, julesMail, 'ref09', /Premium/),
    buy(jade, jadeMail, 'ref05', /Exclusi/),
  ]);
  if (!paidA || !paidB) {
    // Environnement réel seulement : on nettoie quand même, puis le parcours est marqué « non vérifiable ».
    await deleteAccount(sami.page);
    await deleteAccount(p);
    test.skip(true, 'Paiement réel non vérifiable automatiquement (vérification anti-robot de Stripe).');
  }

  for (const [who, email] of [[jules, julesMail], [jade, jadeMail]] as const) {
    await expect(who.page).toHaveURL(/\/commande\//, { timeout: 60_000 });
    await expect(who.page.getByTestId('file-wav')).toBeVisible({ timeout: 90_000 });
    await expect(who.page.getByTestId('file-invoice')).toBeVisible();
    const order = await mail(email, 'order');
    expect(order.text).toContain('renoncé à ton droit de rétractation');
  }
  await shot(jules.page, 'R4-commande-mobile');
  await a11y(jules.page, 'commande');

  // L'exclusive n'est plus en vente.
  const late = await persona('Retardataire');
  await late.page.goto(`/${me.handle}`);
  await late.page.getByTestId('store-track').filter({ hasText: 'ref05' }).getByText('Voir les licences').click();
  await expect(late.page.getByTestId('licence').filter({ hasText: /Exclusi/ })).toHaveCount(0);

  // Max voit ses deux ventes et rembourse celle de Jules ; Jules reçoit l'avoir.
  await p.goto('/app/ventes');
  await expect(p.getByTestId('sale')).toHaveCount(2, { timeout: 30_000 });
  await a11y(p, 'ventes');
  await shot(p, 'R4-ventes');
  p.once('dialog', (d) => d.accept());
  await p.getByTestId('sale').filter({ hasText: 'Premium' }).getByTestId('refund').click();
  await expect(p.getByTestId('sale').filter({ hasText: 'Premium' }).getByTestId('share-status')).toContainText('Rembours', { timeout: 60_000 });
  await mail(julesMail, 'refund');

  // R6 (collaborateur) — Sami veut supprimer son compte : sa part de l'exclusive lui est due, il choisit d'y renoncer.
  await deleteAccount(sami.page, { renounce: true });
  // Max (ventes gardées pour la loi) supprime aussi son compte à la fin : compte rendu anonyme.
  await deleteAccount(p);
  const again = await persona('Visiteur après suppression');
  expect((await again.page.request.get(`/${me.handle}`)).status()).toBe(404);
});
