import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { asService, withViewer } from '@/lib/server/db';
import { createLink, invite, revokeInvite, revokeLink, updateShareSettings, getShareSettings } from '@/lib/server/sharing';
import { linkToken, parseLinkToken, sharedAudioPath, verifySharedAudio } from '@/lib/server/share-token';
import { loadShared, resolveLink, sharedFile, unlock } from '@/lib/server/viewer';
import { createProject, addToProject } from '@/lib/server/library';
import { makeUser } from './helpers';

/** Morceau prêt, inséré directement (le traitement audio est testé ailleurs). */
async function readyTrack(ownerId: string, title = `Beat ${randomUUID().slice(0, 4)}`) {
  return asService(async (tx) => {
    const [t] = await tx<{ id: string }[]>`insert into tracks (owner_id, title) values (${ownerId}, ${title}) returning id`;
    const [v] = await tx<{ id: string }[]>`
      insert into track_versions (track_id, owner_id, version_no, label, status, original_filename, original_key, preview_key, duration_ms)
      values (${t.id}, ${ownerId}, 1, 'v1', 'ready', 'beat.wav', ${`o/${t.id}.wav`}, ${`p/${t.id}.mp3`}, 120000) returning id`;
    await tx`update tracks set current_version_id = ${v.id} where id = ${t.id}`;
    return { id: t.id, versionId: v.id };
  });
}

const tokenOf = (url: string) => url.split('/s/')[1];

async function setup(visibility: 'private' | 'invite' | 'public' = 'public') {
  const owner = await makeUser();
  const t1 = await readyTrack(owner.id, 'Ouvert');
  const t2 = await readyTrack(owner.id, 'Secret');
  const project = await createProject(owner.id, { title: 'Pack' });
  await addToProject(owner.id, project.id, [t1.id, t2.id]);
  await updateShareSettings(owner.id, 'project', project.id, { visibility });
  // t1 sans réglage propre (suit le projet), t2 explicitement privé.
  await updateShareSettings(owner.id, 'track', t2.id, { visibility: 'private' });
  const link = await createLink(owner.id, 'project', project.id, 'Instagram');
  return { owner, t1, t2, project, link, token: tokenOf(link.url) };
}

describe('Jeton de lien', () => {
  it('aller-retour, et jeton inventé ou modifié rejeté', () => {
    const id = randomUUID();
    const tok = linkToken(id);
    expect(tok).toHaveLength(44);
    expect(parseLinkToken(tok)).toBe(id);
    expect(parseLinkToken(tok.slice(0, -1) + (tok.endsWith('A') ? 'B' : 'A'))).toBeNull();
    expect(parseLinkToken(linkToken(id).slice(0, 22) + linkToken(randomUUID()).slice(22))).toBeNull();
    expect(parseLinkToken('../../etc/passwd')).toBeNull();
  });
});

describe('Lot 2.1 — accès', () => {
  it('1. privé = introuvable pour tout tiers, y compris un ancien lien ; la base ne livre rien même en interrogeant directement', async () => {
    const s = await setup('public');
    const stranger = await makeUser();
    expect((await resolveLink(s.token, null, undefined)).status).toBe('ok');
    await updateShareSettings(s.owner.id, 'project', s.project.id, { visibility: 'private' });
    expect((await resolveLink(s.token, null, undefined)).status).toBe('not_found');
    expect((await resolveLink(s.token, stranger.id, undefined)).status).toBe('not_found');
    const linkId = parseLinkToken(s.token)!;
    const leaked = await withViewer({ userId: stranger.id, linkId, unlocked: true }, async (tx) => ({
      projects: await tx`select id from projects where id = ${s.project.id}`,
      tracks: await tx`select id from tracks where id in ${tx([s.t1.id, s.t2.id])}`,
      versions: await tx`select id from track_versions where track_id in ${tx([s.t1.id, s.t2.id])}`,
      pt: await tx`select 1 from project_tracks where project_id = ${s.project.id}`,
    }));
    expect(leaked).toEqual({ projects: [], tracks: [], versions: [], pt: [] });
    // Le propriétaire, lui, voit toujours son aperçu.
    expect((await resolveLink(s.token, s.owner.id, undefined)).status).toBe('ok');
  });

  it('2. sur invitation : anonyme → connexion ; autre compte → refusé ; adresse invitée (casse ignorée) → accès', async () => {
    const s = await setup('invite');
    const guest = await makeUser();
    const other = await makeUser();
    await invite(s.owner.id, 'project', s.project.id, guest.email.toUpperCase(), 'Prod');
    const settings = await getShareSettings(s.owner.id, 'project', s.project.id);
    expect(settings.invites.map((i) => i.email)).toEqual([guest.email]);
    expect((await resolveLink(s.token, null, undefined)).status).toBe('login');
    expect((await resolveLink(s.token, other.id, undefined)).status).toBe('denied');
    const r = await resolveLink(s.token, guest.id, undefined);
    expect(r.status).toBe('ok');
    const view = await loadShared(s.token, r as Extract<typeof r, { status: 'ok' }>);
    expect(view!.tracks.map((t) => t.title)).toEqual(['Ouvert']);
  });

  it('3. lien révoqué ou invitation retirée : inaccessible à la requête suivante (page et audio)', async () => {
    const s = await setup('public');
    const r = await resolveLink(s.token, null, undefined);
    if (r.status !== 'ok') throw new Error('attendu ok');
    expect(await sharedFile(r.ctx, r.meta, s.t1.versionId, 'preview')).not.toBeNull();
    await revokeLink(s.owner.id, parseLinkToken(s.token)!);
    expect((await resolveLink(s.token, null, undefined)).status).toBe('not_found');
    expect(await sharedFile(r.ctx, r.meta, s.t1.versionId, 'preview')).toBeNull();

    const inv = await setup('invite');
    const guest = await makeUser();
    await invite(inv.owner.id, 'project', inv.project.id, guest.email, 'Prod');
    const ok = await resolveLink(inv.token, guest.id, undefined);
    expect(ok.status).toBe('ok');
    const [{ id }] = await asService((tx) => tx<{ id: string }[]>`select id from invites where project_id = ${inv.project.id}`);
    await revokeInvite(inv.owner.id, id);
    expect((await resolveLink(inv.token, guest.id, undefined)).status).toBe('denied');
    if (ok.status === 'ok') expect(await sharedFile(ok.ctx, ok.meta, inv.t1.versionId, 'preview')).toBeNull();
  });

  it('morceau sans réglage : suit le projet partagé, mais reste privé partagé seul', async () => {
    const s = await setup('public');
    const alone = await createLink(s.owner.id, 'track', s.t1.id, 'seul');
    expect((await resolveLink(tokenOf(alone.url), null, undefined)).status).toBe('not_found');
    await updateShareSettings(s.owner.id, 'track', s.t1.id, { visibility: 'public' });
    expect((await resolveLink(tokenOf(alone.url), null, undefined)).status).toBe('ok');
    expect((await getShareSettings(s.owner.id, 'track', s.t2.id)).visibility).toBe('private');
    await updateShareSettings(s.owner.id, 'track', s.t2.id, { visibility: 'inherit' });
    expect((await getShareSettings(s.owner.id, 'track', s.t2.id)).visibility).toBe('inherit');
    await expect(updateShareSettings(s.owner.id, 'project', s.project.id, { visibility: 'inherit' })).rejects.toThrow();
  });

  it('4. morceau privé dans un projet partagé : absent de la page, audio refusé même avec son identifiant', async () => {
    const s = await setup('public');
    const r = await resolveLink(s.token, null, undefined);
    if (r.status !== 'ok') throw new Error('attendu ok');
    const view = await loadShared(s.token, r);
    expect(view!.tracks.map((t) => t.title)).toEqual(['Ouvert']);
    expect(await sharedFile(r.ctx, r.meta, s.t2.versionId, 'preview')).toBeNull();
    // Un morceau protégé par son propre mot de passe n'apparaît pas non plus dans le projet.
    await updateShareSettings(s.owner.id, 'track', s.t2.id, { visibility: 'inherit', password: 'secret123' });
    expect((await loadShared(s.token, r))!.tracks.map((t) => t.title)).toEqual(['Ouvert']);
    await updateShareSettings(s.owner.id, 'track', s.t2.id, { password: null });
    expect((await loadShared(s.token, r))!.tracks.map((t) => t.title)).toEqual(['Ouvert', 'Secret']);
  });

  it('5. mot de passe : rien sans lui ; essais limités ; changé = déverrouillages annulés', async () => {
    const s = await setup('public');
    await updateShareSettings(s.owner.id, 'project', s.project.id, { password: 'bonmotdepasse' });
    const r0 = await resolveLink(s.token, null, undefined);
    expect(r0.status).toBe('password');
    const linkId = parseLinkToken(s.token)!;
    const nothing = await withViewer({ userId: null, linkId, unlocked: false }, (tx) => tx`select id from tracks where id = ${s.t1.id}`);
    expect(nothing).toEqual([]);
    expect((await unlock(s.token, 'faux', 'v1')).ok).toBe(false);
    const good = await unlock(s.token, 'bonmotdepasse', 'v1');
    if (!good.ok) throw new Error('attendu ok');
    expect((await resolveLink(s.token, null, good.value)).status).toBe('ok');
    // 5 erreurs pour un visiteur : bloqué 15 min, même avec le bon mot de passe.
    for (let i = 0; i < 5; i++) await unlock(s.token, `faux${i}`, 'v2');
    expect(await unlock(s.token, 'bonmotdepasse', 'v2')).toMatchObject({ ok: false, error: 'rate_limited' });
    // Effacer son cookie ne suffit pas : 5 erreurs depuis la même adresse IP bloquent aussi.
    for (let i = 0; i < 5; i++) await unlock(s.token, `faux${i}`, randomUUID(), '203.0.113.7');
    expect(await unlock(s.token, 'bonmotdepasse', randomUUID(), '203.0.113.7')).toMatchObject({ ok: false, error: 'rate_limited' });
    // Des dizaines d'erreurs venues d'ailleurs ralentissent le lien mais ne bloquent pas un vrai auditeur.
    const noWait = async () => {};
    for (let i = 0; i < 31; i++) await unlock(s.token, `x${i}`, randomUUID(), `198.51.100.${i}`, noWait);
    let slowed = false;
    expect(await unlock(s.token, 'bonmotdepasse', randomUUID(), '192.0.2.1', async () => { slowed = true; })).toMatchObject({ ok: true });
    expect(slowed).toBe(true);
    // Mot de passe trop court refusé.
    await expect(updateShareSettings(s.owner.id, 'project', s.project.id, { password: 'court' })).rejects.toThrow();
    // Nouveau mot de passe : l'ancien déverrouillage ne vaut plus rien.
    await updateShareSettings(s.owner.id, 'project', s.project.id, { password: 'nouveau-mdp' });
    expect((await resolveLink(s.token, null, good.value)).status).toBe('password');
  });

  it('5 bis. morceau partagé seul avec mot de passe : une fois ouvert, l’auditeur le voit et l’écoute (recette du 25/11)', async () => {
    const owner = await makeUser();
    const t = await readyTrack(owner.id, 'Solo');
    await updateShareSettings(owner.id, 'track', t.id, { visibility: 'public', password: 'motdepasse-solo' });
    const link = await createLink(owner.id, 'track', t.id, 'Label');
    const token = tokenOf(link.url);
    const good = await unlock(token, 'motdepasse-solo', 'v-solo');
    if (!good.ok) throw new Error('attendu ok');
    const r = await resolveLink(token, null, good.value);
    if (r.status !== 'ok') throw new Error('attendu ok');
    const view = await loadShared(token, r);
    expect(view!.tracks).toHaveLength(1);
    expect(view!.tracks[0].hiddenForListeners).toBe(false);
    expect(await sharedFile(r.ctx, r.meta, t.versionId, 'preview')).not.toBeNull();
  });

  it('6. adresse audio expirée ou falsifiée refusée ; ancienne version jamais servie à un tiers', async () => {
    const s = await setup('public');
    const linkId = parseLinkToken(s.token)!;
    const path = sharedAudioPath(s.token, linkId, s.t1.versionId);
    const q = new URL(path, 'http://x').searchParams;
    expect(verifySharedAudio(linkId, s.t1.versionId, q.get('exp'), q.get('sig'))).toBe(true);
    expect(verifySharedAudio(linkId, s.t1.versionId, q.get('exp'), q.get('sig'), Date.now() + 3 * 3600_000)).toBe(false);
    expect(verifySharedAudio(linkId, s.t2.versionId, q.get('exp'), q.get('sig'))).toBe(false);
    expect(verifySharedAudio(linkId, s.t1.versionId, String(Number(q.get('exp')) + 9999), q.get('sig'))).toBe(false);
    // v2 devient courante : v1 n'est plus lisible par un auditeur.
    const v2 = await asService(async (tx) => {
      const [v] = await tx<{ id: string }[]>`insert into track_versions (track_id, owner_id, version_no, label, status, original_filename, original_key, preview_key)
        values (${s.t1.id}, ${s.owner.id}, 2, 'v2', 'ready', 'b.wav', 'o/x2.wav', 'p/x2.mp3') returning id`;
      await tx`update tracks set current_version_id = ${v.id} where id = ${s.t1.id}`;
      return v.id;
    });
    const r = await resolveLink(s.token, null, undefined);
    if (r.status !== 'ok') throw new Error('attendu ok');
    expect(await sharedFile(r.ctx, r.meta, s.t1.versionId, 'preview')).toBeNull();
    expect(await sharedFile(r.ctx, r.meta, v2, 'preview')).not.toBeNull();
  });

  it('téléchargement : refusé par défaut, autorisé seulement si le propriétaire l’active', async () => {
    const s = await setup('public');
    const r = await resolveLink(s.token, null, undefined);
    if (r.status !== 'ok') throw new Error('attendu ok');
    expect(await sharedFile(r.ctx, r.meta, s.t1.versionId, 'original')).toBeNull();
    await updateShareSettings(s.owner.id, 'project', s.project.id, { allowDownload: true });
    expect(await sharedFile(r.ctx, r.meta, s.t1.versionId, 'original')).toMatchObject({ filename: 'beat.wav' });
  });

  it('invitations limitées à 50 par jour et par compte (pas d’envoi de masse)', async () => {
    const s = await setup('invite');
    await asService((tx) => tx`insert into invites (owner_id, project_id, email, created_at)
      select ${s.owner.id}, ${s.project.id}, 'x' || g || '@test.local', now() - interval '1 hour' from generate_series(1, 50) g`);
    await expect(invite(s.owner.id, 'project', s.project.id, 'de-trop@test.local', 'Prod')).rejects.toThrow('50 invitations');
  });

  it('un tiers ne peut ni lire ni modifier les réglages ou les liens d’un autre', async () => {
    const s = await setup('public');
    const other = await makeUser();
    await expect(getShareSettings(other.id, 'project', s.project.id)).rejects.toThrow();
    await expect(updateShareSettings(other.id, 'project', s.project.id, { visibility: 'public' })).rejects.toThrow();
    await expect(createLink(other.id, 'project', s.project.id, 'vol')).rejects.toThrow();
    await expect(revokeLink(other.id, parseLinkToken(s.token)!)).rejects.toThrow();
    // Un auditeur avec un lien valide ne peut rien écrire.
    const linkId = parseLinkToken(s.token)!;
    const n = await withViewer({ userId: other.id, linkId, unlocked: true }, async (tx) => (await tx`update tracks set title = 'pirate' where id = ${s.t1.id}`).count);
    expect(n).toBe(0);
  });
});
