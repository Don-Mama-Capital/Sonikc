import { zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { a11y, address, deleteAccount, expect, fixture, listen, loginHere, MOBILE, noOverflow, reel, shot, signUp, test, trackIds, upload } from './kit';

/**
 * R1 + R2 (et un morceau de R7 : titre piégé). Lina, productrice en offre gratuite, sur téléphone puis ordinateur.
 * Ses auditeurs écoutent en même temps : deux visiteurs anonymes (refus / accord des cookies) et Inès, connectée.
 */
test('@reel R1-R2 Lina : inscription sur téléphone, beats analysés, rangement, partage, écoutes simultanées, statistiques', async ({ persona }) => {
  const lina = await persona('Lina', MOBILE);
  const p = lina.page;
  const me = await signUp(p, 'Lina');
  await a11y(p, 'bibliotheque-vide');
  await shot(p, 'R1-bibliotheque-vide-mobile');
  await noOverflow(p);

  // Trois beats d'un coup, dont un ZIP qui contient deux fichiers (le niveau réel en envoie deux, pour rester léger).
  const files = [fixture('ref01_140_Amin.wav'), fixture('ref02_90_Cmaj.mp3')];
  if (!reel()) {
    const zip = zipSync({ 'ref06_100_Gmin.mp3': readFileSync(fixture('ref06_100_Gmin.mp3')), 'ref07_120_Emin.wav': readFileSync(fixture('ref07_120_Emin.wav')) });
    const zipPath = 'test-results/recette/pack.zip';
    (await import('node:fs')).mkdirSync('test-results/recette', { recursive: true });
    (await import('node:fs')).writeFileSync(zipPath, zip);
    files.push(zipPath);
  }
  await upload(p, files, 2, 180_000);
  const row = (t: string) => p.getByTestId('track-row').filter({ hasText: t });
  await expect(row('ref01 140 Amin')).toContainText('140 BPM · A min');
  await expect(row('ref02 90 Cmaj')).toContainText('90 BPM · C maj');
  if (!reel()) {
    // Le ZIP devient un dossier « pack » avec ses deux beats, analysés aussi.
    await expect(p.getByTestId('folder').filter({ hasText: 'pack' })).toContainText('2 éléments', { timeout: 180_000 });
    await p.getByTestId('folder').filter({ hasText: 'pack' }).getByRole('link').click();
    await expect(p.getByTestId('track-row').filter({ hasText: 'BPM' })).toHaveCount(2, { timeout: 180_000 });
    await expect(row('ref06 100 Gmin')).toContainText('100 BPM · G min');
    await expect(row('ref07 120 Emin')).toContainText('120 BPM · E min');
    await p.goto('/app');
  }
  await shot(p, 'R1-bibliotheque-analysee-mobile');
  await noOverflow(p);
  const ids = await trackIds(p);

  // Rangement : dossier, déplacement, suppression du dossier sans perte.
  await p.getByRole('button', { name: '+ Dossier' }).click();
  await p.getByLabel('Nom du dossier').fill('Été 2026');
  await p.getByRole('button', { name: 'Créer' }).click();
  await expect(p.getByTestId('folder').filter({ hasText: 'Été 2026' })).toBeVisible();
  await row('ref02 90 Cmaj').getByLabel('Actions ref02 90 Cmaj').click();
  await row('ref02 90 Cmaj').getByRole('button', { name: 'Déplacer' }).click();
  await p.getByTestId('move-dialog').getByRole('button', { name: /Été 2026/ }).click();
  await expect(row('ref02 90 Cmaj')).toHaveCount(0);
  await p.getByLabel('Actions Été 2026').click();
  await p.getByTestId('delete-folder').click();
  await expect(row('ref02 90 Cmaj')).toHaveCount(1);

  // Fiche du morceau : titre piégé (R7), tags, nouvelle version ; corbeille puis restauration.
  await p.goto(`/app/tracks/${ids['ref01 140 Amin']}`);
  const trap = 'Nuit <img src=x onerror="window.__xss=1">';
  await p.getByLabel('Titre').fill(trap);
  await p.getByLabel('Tags').fill('#trap #dark');
  await p.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(p.getByTestId('saved')).toBeVisible();
  await p.getByTestId('file-input').setInputFiles(fixture('ref05_160_Ebmaj.wav'));
  await expect(p.getByTestId('version-row')).toHaveCount(2, { timeout: 60_000 });
  await expect(p.getByTestId('version-row').filter({ hasText: 'analyse…' })).toHaveCount(0, { timeout: 120_000 });
  await shot(p, 'R1-fiche-morceau-mobile');
  await a11y(p, 'fiche-morceau');
  await p.getByRole('button', { name: 'Mettre à la corbeille' }).click();
  await expect(p).toHaveURL(/\/app$/);
  await p.goto('/app/trash');
  await expect(p.getByTestId('trash-row')).toHaveCount(1);
  await p.getByTestId('trash-row').getByRole('button', { name: 'Restaurer' }).click();
  await expect(p.getByTestId('trash-row')).toHaveCount(0);

  // Lina passe sur ordinateur.
  await p.setViewportSize({ width: 1280, height: 800 });
  const trackId = ids['ref02 90 Cmaj'];
  await p.goto(`/app/tracks/${trackId}`);
  await p.getByTestId('share').click();
  await p.getByTestId('vis-public').check();
  await p.getByPlaceholder('Nom du lien').fill('Instagram');
  await p.getByTestId('create-link').click();
  const linkRow = p.getByTestId('link-row').filter({ hasText: 'Instagram' });
  await expect(linkRow).toBeVisible();
  const url = (await linkRow.getAttribute('data-url'))!;
  await p.getByTestId('allow-download').check();
  // Offre gratuite : pas de lien protégé par mot de passe, message clair.
  await p.getByPlaceholder(/Optionnel/).fill('motdepasse2026');
  await p.getByRole('button', { name: 'Protéger' }).click();
  await expect(p.getByTestId('share-panel').locator('p[role=alert]')).toContainText('Limite de ton offre');
  await shot(p, 'R2-partage-ordinateur');
  await a11y(p, 'panneau-partage');

  // Trois auditeurs en même temps.
  const [refus, accord, ines] = await Promise.all([
    (async () => (await persona('Visiteur refus', MOBILE)))(),
    (async () => (await persona('Visiteur accord')))(),
    (async () => (await persona('Inès')))(),
  ]);
  await Promise.all([
    (async () => {
      await refus.page.goto(url);
      await shot(refus.page, 'R2-partage-bandeau-mobile');
      await a11y(refus.page, 'page-partage');
      await refus.page.getByTestId('consent-refuse').click();
      await listen(refus.page, 'ref02 90 Cmaj', 6);
      expect((await refus.ctx.cookies()).map((c) => c.name)).not.toContain('sk_vid');
      await noOverflow(refus.page);
    })(),
    (async () => {
      await accord.page.goto(url);
      await accord.page.getByTestId('consent-accept').click();
      await listen(accord.page, 'ref02 90 Cmaj', 6);
      expect((await accord.ctx.cookies()).map((c) => c.name)).toContain('sk_vid');
      // Rechargement avec accord : la réécoute ne crée pas un deuxième auditeur.
      await accord.page.reload();
      await listen(accord.page, 'ref02 90 Cmaj', 3);
    })(),
    (async () => {
      const q = ines.page;
      await q.goto(url);
      await q.getByTestId('consent-accept').click();
      await q.getByRole('link', { name: 'Se connecter pour enregistrer' }).click();
      await loginHere(q, address('Ines'));
      await expect(q.getByTestId('shared-title')).toBeVisible();
      await listen(q, 'ref02 90 Cmaj', 6);
      await q.getByTestId('favorite').first().click();
      await expect(q.getByTestId('favorite').first()).toHaveAttribute('aria-pressed', 'true');
      const dl = q.waitForEvent('download');
      await q.getByRole('link', { name: /Télécharger ref02/ }).click();
      expect((await (await dl).path())).toBeTruthy();
      await q.getByTestId('save').click();
      await expect(q.getByTestId('save')).toHaveText('✓ Enregistré dans mes reçus');
      await q.getByRole('link', { name: 'Mes reçus' }).click();
      await expect(q.getByTestId('received-item')).toHaveCount(1);
      await a11y(q, 'recus');
    })(),
  ]);

  // Lina voit tout : 3 auditeurs, le nom d'Inès, les notifications (écoute, favori, téléchargement, enregistrement).
  await p.goto(`/app/tracks/${trackId}`);
  await expect(p.getByTestId('stat-listeners')).toHaveText('3', { timeout: 20_000 });
  await expect(p.getByTestId('recent-listens')).toContainText('Inès');
  await expect(p.getByTestId('recent-listens')).toContainText('Anonyme');
  await expect(p.getByTestId('bell-count')).toBeVisible();
  await p.getByTestId('bell').click();
  await expect(p.getByTestId('notification').filter({ hasText: 'a mis en favori' })).toHaveCount(1);
  await expect(p.getByTestId('notification').filter({ hasText: 'a téléchargé' })).toHaveCount(1);
  await expect(p.getByTestId('notification').filter({ hasText: 'a enregistré' })).toHaveCount(1);
  await shot(p, 'R2-statistiques-ordinateur');
  await a11y(p, 'statistiques');

  // Page publique : le titre piégé reste du texte, aucun script exécuté.
  await p.request.patch(`/api/share/track/${ids['ref01 140 Amin']}`, { data: { visibility: 'public' } });
  const pub = await persona('Visiteur page publique');
  await pub.page.goto(`/${me.handle}`);
  await expect(pub.page.getByTestId('store-tracks')).toContainText('<img src=x');
  expect(await pub.page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await a11y(pub.page, 'page-publique');

  // Fin : Lina et Inès suppriment leur compte (nettoyage de l'environnement réel, et parcours de suppression).
  await deleteAccount(p);
  await deleteAccount(ines.page);
});
