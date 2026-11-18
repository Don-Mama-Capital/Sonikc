import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { asService, withUser } from '@/lib/server/db';
import { createLink, invite, revokeInvite, revokeLink, updateShareSettings } from '@/lib/server/sharing';
import { linkToken, parseLinkToken } from '@/lib/server/share-token';
import { isSaved, listReceived, saveLink, unsaveLink } from '@/lib/server/saves';
import { linkFunnel, listenStart, notifications } from '@/lib/server/listening';
import { resolveLink, sharedFile, unlock } from '@/lib/server/viewer';
import { addToProject, createProject } from '@/lib/server/library';
import { makeUser } from './helpers';

async function readyTrack(ownerId: string, title: string) {
  return asService(async (tx) => {
    const [t] = await tx<{ id: string }[]>`insert into tracks (owner_id, title) values (${ownerId}, ${title}) returning id`;
    const [v] = await tx<{ id: string }[]>`insert into track_versions (track_id, owner_id, version_no, label, status, original_filename, original_key, preview_key, duration_ms)
      values (${t.id}, ${ownerId}, 1, 'v1', 'ready', 'b.wav', ${`o/${t.id}`}, ${`p/${t.id}`}, 90000) returning id`;
    await tx`update tracks set current_version_id = ${v.id} where id = ${t.id}`;
    return { id: t.id, versionId: v.id };
  });
}

async function setup() {
  const owner = await makeUser();
  const a = await readyTrack(owner.id, 'A');
  const project = await createProject(owner.id, { title: 'Pack' });
  await addToProject(owner.id, project.id, [a.id]);
  await updateShareSettings(owner.id, 'project', project.id, { visibility: 'public' });
  const link = await createLink(owner.id, 'project', project.id, 'Instagram');
  const linkId = parseLinkToken(link.url.split('/s/')[1])!;
  return { owner, a, project, linkId, token: linkToken(linkId) };
}
const ctx = (userId: string | null, linkId: string) => ({ userId, linkId, unlocked: false });
const none = () => undefined;
const received = async (userId: string, cookie: (n: string) => string | undefined) => (await listReceived(userId, cookie)).items;

describe('Lot 2.4 — Reçus', () => {
  it('1. enregistrer un partage : il apparaît dans Reçus, écoutable, et suit le contenu actuel du producteur', async () => {
    const s = await setup();
    const fan = await makeUser();
    expect(await saveLink(ctx(fan.id, s.linkId))).toBe(true);
    expect(await isSaved(ctx(fan.id, s.linkId))).toBe(true);
    let list = await received(fan.id, none);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ available: true });
    if (!list[0].available) throw new Error();
    expect(list[0].view.tracks.map((t) => t.title)).toEqual(['A']);
    // Le producteur ajoute un morceau : il apparaît sans rien refaire.
    const b = await readyTrack(s.owner.id, 'B');
    await addToProject(s.owner.id, s.project.id, [b.id]);
    list = await received(fan.id, none);
    if (!list[0].available) throw new Error();
    expect(list[0].view.tracks.map((t) => t.title)).toEqual(['A', 'B']);
    // Retirer.
    await unsaveLink(fan.id, s.linkId);
    expect(await received(fan.id, none)).toEqual([]);
  });

  it('2. le producteur garde la main : révocation, privé, invitation retirée, mot de passe changé → indisponible', async () => {
    const s = await setup();
    const fan = await makeUser();
    await saveLink(ctx(fan.id, s.linkId));
    await updateShareSettings(s.owner.id, 'project', s.project.id, { visibility: 'private' });
    expect(await received(fan.id, none)).toMatchObject([{ available: false, reason: 'gone' }]);
    await updateShareSettings(s.owner.id, 'project', s.project.id, { visibility: 'public', password: 'motdepasse1' });
    const u = await unlock(s.token, 'motdepasse1', randomUUID());
    if (!u.ok) throw new Error();
    expect(await received(fan.id, (n) => (n === u.cookieName ? u.value : undefined))).toMatchObject([{ available: true }]);
    await updateShareSettings(s.owner.id, 'project', s.project.id, { password: 'autremotdepasse' });
    expect(await received(fan.id, (n) => (n === u.cookieName ? u.value : undefined))).toMatchObject([{ available: false, reason: 'password' }]);
    await updateShareSettings(s.owner.id, 'project', s.project.id, { password: null });
    expect(await received(fan.id, none)).toMatchObject([{ available: true }]);
    await revokeLink(s.owner.id, s.linkId);
    expect(await received(fan.id, none)).toMatchObject([{ available: false }]);
    const r = await resolveLink(s.token, fan.id, undefined);
    expect(r.status).toBe('not_found');
    expect(await sharedFile(ctx(fan.id, s.linkId), { kind: 'project', targetId: s.project.id } as never, s.a.versionId, 'preview')).toBeNull();
    // Aucune copie : un enregistrement ne contient qu'une référence au lien.
    const cols = await asService((tx) => tx<{ column_name: string }[]>`select column_name from information_schema.columns where table_name = 'saves' order by column_name`);
    expect(cols.map((c) => c.column_name)).toEqual(['contact_id', 'created_at', 'id', 'link_id', 'owner_id', 'user_id']); // contact_id : lot 3.1

    // Invitation retirée.
    const inv = await setup();
    await updateShareSettings(inv.owner.id, 'project', inv.project.id, { visibility: 'invite' });
    const guest = await makeUser();
    await invite(inv.owner.id, 'project', inv.project.id, guest.email, 'Prod');
    const [{ link_id, id }] = await asService((tx) => tx<{ link_id: string; id: string }[]>`select link_id, id from invites where project_id = ${inv.project.id}`);
    await saveLink(ctx(guest.id, link_id));
    expect(await received(guest.id, none)).toMatchObject([{ available: true }]);
    await revokeInvite(inv.owner.id, id);
    expect(await received(guest.id, none)).toMatchObject([{ available: false }]);
  });

  it('3. une écoute depuis Reçus est suivie avec la source du lien', async () => {
    const s = await setup();
    const fan = await makeUser();
    await saveLink(ctx(fan.id, s.linkId));
    const [it] = await received(fan.id, none);
    if (!it.available) throw new Error();
    const r = await resolveLink(it.token, fan.id, undefined);
    if (r.status !== 'ok') throw new Error();
    expect((await listenStart(r.ctx, s.a.id, randomUUID())).tracked).toBe(true);
    const [row] = await asService((tx) => tx<{ source: string; listener_id: string }[]>`select source, listener_id from listen_sessions where track_id = ${s.a.id}`);
    expect(row).toEqual({ source: 'Instagram', listener_id: fan.id });
  });

  it('4. le producteur voit les enregistrements par lien et reçoit une seule notification par auditeur', async () => {
    const s = await setup();
    const fan = await makeUser();
    await saveLink(ctx(fan.id, s.linkId));
    await unsaveLink(fan.id, s.linkId);
    await saveLink(ctx(fan.id, s.linkId));
    const [f] = await linkFunnel(s.owner.id, 'project', s.project.id);
    expect(f.saved).toBe(1);
    const n = await notifications(s.owner.id);
    expect(n.items.filter((i) => i.kind === 'save')).toEqual([expect.objectContaining({ actor: fan.handle, title: 'Pack', projectId: s.project.id, count: 1 })]);
  });

  it('5. anonyme refusé, propriétaire ignoré, et chacun ne voit que ses propres enregistrements', async () => {
    const s = await setup();
    await expect(saveLink(ctx(null, s.linkId))).rejects.toThrow('login required');
    expect(await saveLink(ctx(s.owner.id, s.linkId))).toBe(false);
    const fan = await makeUser();
    const other = await makeUser();
    await saveLink(ctx(fan.id, s.linkId));
    expect(await received(other.id, none)).toEqual([]);
    const seen = await withUser(other.id, (tx) => tx`select 1 from saves`);
    expect(seen).toEqual([]);
    // Un autre compte ne peut pas retirer l'enregistrement de quelqu'un d'autre.
    await unsaveLink(other.id, s.linkId);
    expect(await isSaved(ctx(fan.id, s.linkId))).toBe(true);
    // Lien d'un projet où l'on n'a pas accès : refusé.
    await updateShareSettings(s.owner.id, 'project', s.project.id, { visibility: 'private' });
    await expect(saveLink(ctx(other.id, s.linkId))).rejects.toThrow('not allowed');
  });

  it('6. notifications regroupées : compteur de personnes, premier nom conservé, par lien', async () => {
    const s = await setup();
    for (let i = 0; i < 3; i++) await listenStart(ctx(null, s.linkId), s.a.id, randomUUID());
    let listens = (await notifications(s.owner.id)).items.filter((i) => i.kind === 'listen');
    expect(listens).toHaveLength(1);
    expect(listens[0].count).toBe(3);

    // Revue : un vrai auditeur puis 6 lectures d'un autre compte → 2 personnes, le premier nom reste.
    const t = await setup();
    const real = await makeUser();
    const spoof = await makeUser();
    await listenStart(ctx(real.id, t.linkId), t.a.id, randomUUID());
    for (let i = 0; i < 6; i++) await listenStart(ctx(spoof.id, t.linkId), t.a.id, randomUUID());
    listens = (await notifications(t.owner.id)).items.filter((i) => i.kind === 'listen');
    expect(listens).toEqual([expect.objectContaining({ actor: real.handle, count: 2 })]);

    // Même personne, même visiteur, qui réécoute après 31 min : toujours 1 personne.
    const u = await setup();
    const v = randomUUID();
    const first = await listenStart(ctx(null, u.linkId), u.a.id, v);
    await asService((tx) => tx`update listen_sessions set last_beat_at = now() - interval '31 minutes' where id = ${first.sessionId}`);
    await listenStart(ctx(null, u.linkId), u.a.id, v);
    listens = (await notifications(u.owner.id)).items.filter((i) => i.kind === 'listen');
    expect(listens).toEqual([expect.objectContaining({ count: 1 })]);

    // Deux liens au même nom : deux notifications distinctes.
    const other = await createLink(u.owner.id, 'project', u.project.id, 'Instagram');
    await listenStart(ctx(null, parseLinkToken(other.url.split('/s/')[1])!), u.a.id, randomUUID());
    expect((await notifications(u.owner.id)).items.filter((i) => i.kind === 'listen')).toHaveLength(2);
  });

  it('garde-fous : 200 partages enregistrés par compte, Reçus par pages de 30, 50 liens actifs par partage', async () => {
    const s = await setup();
    const fan = await makeUser();
    const ids = await asService(async (tx) => (await tx<{ id: string }[]>`
      insert into share_links (owner_id, project_id, label) select ${s.owner.id}, ${s.project.id}, 'L' || g from generate_series(1, 201) g returning id`).map((r) => r.id));
    await asService((tx) => tx`insert into saves (user_id, link_id, owner_id) select ${fan.id}, unnest(${ids.slice(0, 200)}::uuid[]), ${s.owner.id}`);
    await expect(saveLink(ctx(fan.id, ids[200]))).rejects.toThrow('too many saves');
    const p0 = await listReceived(fan.id, none, 0);
    expect(p0.items).toHaveLength(30);
    expect(p0.hasMore).toBe(true);
    const last = await listReceived(fan.id, none, 6);
    expect(last.items).toHaveLength(20);
    expect(last.hasMore).toBe(false);
    await expect(createLink(s.owner.id, 'project', s.project.id, 'de trop')).rejects.toThrow('50 liens actifs');
  });
});
