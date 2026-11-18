import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { asService } from '@/lib/server/db';
import { createLink, invite, revokeLink, updateShareSettings } from '@/lib/server/sharing';
import { parseLinkToken } from '@/lib/server/share-token';
import { resolveLink } from '@/lib/server/viewer';
import { interact, linkFunnel, listenBeat, listenStart, markNotificationsRead, notifications, recordView, trackStats } from '@/lib/server/listening';
import { makeUser } from './helpers';

async function readyTrack(ownerId: string, durationMs = 120_000) {
  return asService(async (tx) => {
    const [t] = await tx<{ id: string }[]>`insert into tracks (owner_id, title, visibility) values (${ownerId}, 'Nuit', 'public') returning id`;
    const [v] = await tx<{ id: string }[]>`insert into track_versions (track_id, owner_id, version_no, label, status, original_filename, original_key, preview_key, duration_ms)
      values (${t.id}, ${ownerId}, 1, 'v1', 'ready', 'n.wav', ${`o/${t.id}`}, ${`p/${t.id}`}, ${durationMs}) returning id`;
    await tx`update tracks set current_version_id = ${v.id} where id = ${t.id}`;
    return t.id;
  });
}

async function setup(label = 'Instagram') {
  const owner = await makeUser();
  const trackId = await readyTrack(owner.id);
  const link = await createLink(owner.id, 'track', trackId, label);
  const linkId = parseLinkToken(link.url.split('/s/')[1])!;
  const ctx = (userId: string | null = null) => ({ userId, linkId, unlocked: false });
  return { owner, trackId, link, linkId, ctx };
}

/** Simule le temps qui passe : recule le dernier battement de la session. */
const elapse = (sessionId: string, seconds: number) =>
  asService((tx) => tx`update listen_sessions set last_beat_at = last_beat_at - ${`${seconds} seconds`}::interval,
                       started_at = started_at - ${`${seconds} seconds`}::interval where id = ${sessionId}`);

describe('Lot 2.2 — suivi d’écoute', () => {
  it('1. durée mesurée à ± 5 s ; une durée annoncée trop longue est plafonnée par le temps écoulé', async () => {
    const s = await setup();
    const v = randomUUID();
    const { sessionId } = await listenStart(s.ctx(), s.trackId, v);
    for (let i = 0; i < 8; i++) { await elapse(sessionId!, 5); await listenBeat(s.ctx(), sessionId!, v, 5000); }
    const [{ ms }] = await asService((tx) => tx<{ ms: number }[]>`select listened_ms as ms from listen_sessions where id = ${sessionId}`);
    expect(Math.abs(ms - 40_000)).toBeLessThanOrEqual(5_000);
    // Le client prétend 60 s après 5 s réelles : au plus 5 s + 2 s de marge sont comptées.
    await elapse(sessionId!, 5);
    const after = await listenBeat(s.ctx(), sessionId!, v, 60_000);
    expect(after! - ms).toBeLessThanOrEqual(7_100);
    // Un autre visiteur ne peut pas alimenter la session.
    expect(await listenBeat(s.ctx(), sessionId!, randomUUID(), 5000)).toBeNull();
  });

  it('1 bis. battements en rafale : rien n’est gagné au-delà du temps réel écoulé depuis le début', async () => {
    const s = await setup();
    const v = randomUUID();
    const { sessionId } = await listenStart(s.ctx(), s.trackId, v);
    const t0 = Date.now();
    let last = 0;
    for (let i = 0; i < 60; i++) last = (await listenBeat(s.ctx(), sessionId!, v, 600_000)) ?? last;
    expect(last).toBeLessThanOrEqual(Date.now() - t0 + 2_100);
  });

  it('garde-fous : notifications regroupées, écoutes fabriquées en masse plafonnées', async () => {
    const s = await setup();
    for (let i = 0; i < 70; i++) await listenStart(s.ctx(), s.trackId, randomUUID());
    const [{ sessions }] = await asService((tx) => tx<{ sessions: number }[]>`select count(*)::int as sessions from listen_sessions where track_id = ${s.trackId}`);
    expect(sessions).toBe(60);
    expect((await notifications(s.owner.id)).unread).toBe(1);
  });

  it('nom de l’auditeur : jamais son adresse sur un lien public ; son adresse s’il est invité', async () => {
    const s = await setup();
    const noProfile = await asService(async (tx) => (await tx<{ id: string }[]>`insert into users (email) values (${`np_${randomUUID().slice(0, 6)}@test.local`}) returning id`)[0]);
    await listenStart(s.ctx(noProfile.id), s.trackId, randomUUID());
    const guestEmail = `g_${randomUUID().slice(0, 6)}@test.local`;
    const guest = await asService(async (tx) => (await tx<{ id: string }[]>`insert into users (email) values (${guestEmail}) returning id`)[0]);
    const inv = await invite(s.owner.id, 'track', s.trackId, guestEmail, 'Prod');
    expect(inv.email).toBe(guestEmail);
    const [{ link_id }] = await asService((tx) => tx<{ link_id: string }[]>`select link_id from invites where email = ${guestEmail}`);
    await listenStart({ userId: guest.id, linkId: link_id, unlocked: false }, s.trackId, randomUUID());
    const names = await asService((tx) => tx<{ n: string }[]>`select listener_name as n from listen_sessions where track_id = ${s.trackId} order by started_at`);
    expect(names.map((x) => x.n)).toEqual(['Auditeur connecté', guestEmail]);
  });

  it('2. rechargement : même visiteur, même morceau, même lien, moins de 30 min = même écoute', async () => {
    const s = await setup();
    const v = randomUUID();
    const a = await listenStart(s.ctx(), s.trackId, v);
    const b = await listenStart(s.ctx(), s.trackId, v);
    expect(b).toMatchObject({ sessionId: a.sessionId, resumed: true });
    const other = await listenStart(s.ctx(), s.trackId, randomUUID());
    expect(other.sessionId).not.toBe(a.sessionId);
    await elapse(a.sessionId!, 31 * 60);
    const later = await listenStart(s.ctx(), s.trackId, v);
    expect(later.sessionId).not.toBe(a.sessionId);
    const [{ n }] = await asService((tx) => tx<{ n: number }[]>`select count(*)::int as n from listen_sessions where track_id = ${s.trackId}`);
    expect(n).toBe(3);
  });

  it('3. écoutes du propriétaire non enregistrées', async () => {
    const s = await setup();
    const r = await listenStart(s.ctx(s.owner.id), s.trackId, randomUUID());
    expect(r).toMatchObject({ tracked: false, sessionId: null });
    expect(await recordView(s.ctx(s.owner.id), randomUUID())).toBe(false);
    const [{ n }] = await asService((tx) => tx<{ n: number }[]>`select count(*)::int as n from listen_sessions where track_id = ${s.trackId}`);
    expect(n).toBe(0);
  });

  it('5. source et auditeur : nom du lien ; compte connecté nommé ; anonyme sans donnée personnelle', async () => {
    const s = await setup('DM label');
    const guest = await makeUser();
    await listenStart(s.ctx(guest.id), s.trackId, randomUUID());
    await listenStart(s.ctx(), s.trackId, randomUUID());
    const rows = await asService((tx) => tx<{ source: string; listener_name: string | null; listener_id: string | null }[]>`
      select source, listener_name, listener_id from listen_sessions where track_id = ${s.trackId} order by listener_name nulls last`);
    expect(rows).toEqual([
      { source: 'DM label', listener_name: guest.handle, listener_id: guest.id },
      { source: 'DM label', listener_name: null, listener_id: null },
    ]);
  });

  it('accès revérifié : lien révoqué ou morceau non accordé = rien n’est enregistré', async () => {
    const s = await setup();
    const v = randomUUID();
    const { sessionId } = await listenStart(s.ctx(), s.trackId, v);
    const otherTrack = await readyTrack(s.owner.id);
    await expect(listenStart(s.ctx(), otherTrack, v)).rejects.toThrow('not allowed');
    await revokeLink(s.owner.id, s.linkId);
    await elapse(sessionId!, 5);
    expect(await listenBeat(s.ctx(), sessionId!, v, 5000)).toBeNull();
    await expect(listenStart(s.ctx(), s.trackId, v)).rejects.toThrow('not allowed');
  });

  it('6. interactions : téléchargement seulement si autorisé ; favori pour un compte connecté, sans doublon', async () => {
    const s = await setup();
    const fan = await makeUser();
    await expect(interact(s.ctx(), s.trackId, randomUUID(), 'download')).rejects.toThrow('not allowed');
    await updateShareSettings(s.owner.id, 'track', s.trackId, { allowDownload: true });
    expect(await interact(s.ctx(), s.trackId, randomUUID(), 'download')).toBe(true);
    await expect(interact(s.ctx(), s.trackId, randomUUID(), 'favorite')).rejects.toThrow('login required');
    await interact(s.ctx(fan.id), s.trackId, randomUUID(), 'favorite');
    await interact(s.ctx(fan.id), s.trackId, randomUUID(), 'favorite');
    let stats = await trackStats(s.owner.id, s.trackId);
    expect(stats).toMatchObject({ downloads: 1, favorites: 1 });
    await interact(s.ctx(fan.id), s.trackId, randomUUID(), 'unfavorite');
    stats = await trackStats(s.owner.id, s.trackId);
    expect(stats.favorites).toBe(0);
  });
});

describe('Lot 2.3 — stats et notifications', () => {
  it('1 et 4. stats par morceau = la base ; détail par source ; écoutes récentes', async () => {
    const s = await setup('Instagram');
    const dm = await createLink(s.owner.id, 'track', s.trackId, 'DM');
    const dmCtx: { userId: string | null; linkId: string; unlocked: boolean } = { userId: null, linkId: parseLinkToken(dm.url.split('/s/')[1])!, unlocked: false };
    const plays: [typeof dmCtx, number][] = [[s.ctx(), 120_000], [s.ctx(), 20_000], [dmCtx, 100_000]];
    for (const [ctx, ms] of plays) {
      const v = randomUUID();
      const { sessionId } = await listenStart(ctx, s.trackId, v);
      await asService((tx) => tx`update listen_sessions set listened_ms = ${ms} where id = ${sessionId}`);
    }
    const st = await trackStats(s.owner.id, s.trackId);
    const [db] = await asService((tx) => tx<{ plays: number; listeners: number; total: number }[]>`
      select count(*)::int as plays, count(distinct visitor)::int as listeners, sum(listened_ms)::int as total from listen_sessions where track_id = ${s.trackId}`);
    expect(st).toMatchObject({ plays: db.plays, listeners: db.listeners, totalMs: db.total, avgMs: Math.round(db.total / db.plays), complete: 2 });
    expect(st.bySource).toEqual([
      { source: 'Instagram', plays: 2, listeners: 2, totalMs: 140_000 },
      { source: 'DM', plays: 1, listeners: 1, totalMs: 100_000 },
    ]);
    expect(st.recent).toHaveLength(3);
    expect(st.recent[0]).toMatchObject({ who: null, source: 'DM', listenedMs: 100_000 });
    // Un autre utilisateur ne voit rien.
    const other = await makeUser();
    await expect(trackStats(other.id, s.trackId)).rejects.toThrow();
  });

  it('2. entonnoir par lien : ouvertures → lectures → plus de 30 s → complète → téléchargement', async () => {
    const s = await setup();
    await updateShareSettings(s.owner.id, 'track', s.trackId, { allowDownload: true });
    const visitors = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const v of visitors) await recordView(s.ctx(), v);
    await recordView(s.ctx(), visitors[0]); // même visiteur dans les 30 min : une seule ouverture
    const listened = [10_000, 45_000, 110_000];
    for (let i = 0; i < 3; i++) {
      const { sessionId } = await listenStart(s.ctx(), s.trackId, visitors[i]);
      await asService((tx) => tx`update listen_sessions set listened_ms = ${listened[i]} where id = ${sessionId}`);
    }
    await interact(s.ctx(), s.trackId, visitors[2], 'download');
    const [f] = await linkFunnel(s.owner.id, 'track', s.trackId);
    expect(f).toMatchObject({ label: 'Instagram', opened: 4, played: 3, over30: 2, complete: 1, downloaded: 1 });
  });

  it('3. notification créée au début d’une écoute (pas à la reprise), lue par le seul propriétaire', async () => {
    const s = await setup();
    const guest = await makeUser();
    await invite(s.owner.id, 'track', s.trackId, guest.email, 'Prod').catch(() => {});
    const v = randomUUID();
    await listenStart(s.ctx(guest.id), s.trackId, v);
    await listenStart(s.ctx(guest.id), s.trackId, v);
    const n = await notifications(s.owner.id);
    expect(n.unread).toBe(1);
    expect(n.items[0]).toMatchObject({ kind: 'listen', actor: guest.handle, source: 'Instagram', trackTitle: 'Nuit' });
    expect((await notifications(guest.id)).items).toHaveLength(0);
    await markNotificationsRead(s.owner.id);
    expect((await notifications(s.owner.id)).unread).toBe(0);
  });
});

describe('Résolution + suivi', () => {
  it('le contexte issu de resolveLink suffit pour suivre une écoute', async () => {
    const s = await setup();
    const r = await resolveLink(s.link.url.split('/s/')[1], null, undefined);
    if (r.status !== 'ok') throw new Error('attendu ok');
    expect((await listenStart(r.ctx, s.trackId, randomUUID())).tracked).toBe(true);
  });
});
