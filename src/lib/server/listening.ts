import { z } from 'zod';
import { withUser, withViewer, type ViewerCtx } from './db';
import { NotFound } from './library';

/**
 * Suivi des écoutes (lot 2.2) et stats (lot 2.3).
 * Côté auditeur : uniquement des fonctions de la base qui revérifient le lien (app.listen_*, app.interact).
 * Côté propriétaire : lectures filtrées par la RLS.
 */

const uuid = z.string().uuid();
const visitorSchema = z.string().regex(/^[0-9a-f-]{36}$/);

export async function recordView(ctx: ViewerCtx, visitor: string) {
  visitorSchema.parse(visitor);
  return withViewer(ctx, async (tx) => (await tx<{ ok: boolean }[]>`select app.record_view(${visitor}) as ok`)[0].ok);
}

export async function listenStart(ctx: ViewerCtx, trackId: string, visitor: string) {
  uuid.parse(trackId); visitorSchema.parse(visitor);
  return withViewer(ctx, async (tx) => {
    const [r] = await tx<{ session_id: string | null; tracked: boolean; resumed: boolean }[]>`select * from app.listen_start(${trackId}, ${visitor})`;
    return { sessionId: r.session_id, tracked: r.tracked, resumed: r.resumed };
  });
}

export async function listenBeat(ctx: ViewerCtx, sessionId: string, visitor: string, playedMs: number) {
  uuid.parse(sessionId); visitorSchema.parse(visitor);
  const ms = Math.max(0, Math.min(Math.round(Number(playedMs) || 0), 600_000));
  return withViewer(ctx, async (tx) => (await tx<{ ms: number | null }[]>`select app.listen_beat(${sessionId}, ${visitor}, ${ms}) as ms`)[0].ms);
}

export async function interact(ctx: ViewerCtx, trackId: string, visitor: string, kind: 'download' | 'favorite' | 'unfavorite') {
  uuid.parse(trackId); visitorSchema.parse(visitor);
  return withViewer(ctx, async (tx) => (await tx<{ ok: boolean }[]>`select app.interact(${trackId}, ${visitor}, ${kind}) as ok`)[0].ok);
}

export async function myFavorites(ctx: ViewerCtx) {
  if (!ctx.userId) return [];
  return withViewer(ctx, async (tx) => (await tx<{ id: string }[]>`select app.my_favorites() as id`).map((r) => r.id));
}

// ───────────── Propriétaire : stats ─────────────

const COMPLETE = 0.8;

export async function trackStats(userId: string, trackId: string) {
  uuid.parse(trackId);
  return withUser(userId, async (tx) => {
    const [t] = await tx`select 1 from tracks where id = ${trackId}`;
    if (!t) throw new NotFound();
    const [totals] = await tx<{ plays: number; listeners: number; totalMs: number; avgMs: number; complete: number; downloads: number; favorites: number }[]>`
      select count(*)::int as plays,
             count(distinct coalesce(listener_id::text, visitor))::int as listeners,
             coalesce(sum(listened_ms), 0)::int as "totalMs",
             coalesce(round(avg(listened_ms)), 0)::int as "avgMs",
             count(*) filter (where duration_ms > 0 and listened_ms >= duration_ms * ${COMPLETE}::numeric)::int as complete,
             (select count(*)::int from interactions i where i.track_id = ${trackId} and i.kind = 'download') as downloads,
             (select count(*)::int from interactions i where i.track_id = ${trackId} and i.kind = 'favorite') as favorites
      from listen_sessions where track_id = ${trackId}`;
    const bySource = await tx<{ source: string; plays: number; listeners: number; totalMs: number }[]>`
      select source, count(*)::int as plays, count(distinct coalesce(listener_id::text, visitor))::int as listeners,
             coalesce(sum(listened_ms), 0)::int as "totalMs"
      from listen_sessions where track_id = ${trackId} group by source order by plays desc, source`;
    const recent = await tx<{ id: string; who: string | null; source: string; startedAt: Date; listenedMs: number; durationMs: number | null }[]>`
      select id, listener_name as who, source, started_at as "startedAt", listened_ms as "listenedMs", duration_ms as "durationMs"
      from listen_sessions where track_id = ${trackId} order by started_at desc limit 20`;
    return { ...totals, bySource, recent: recent.map((r) => ({ ...r, startedAt: r.startedAt.toISOString() })) };
  });
}

/** Entonnoir par lien : ouvertures → lectures → plus de 30 s → écoute complète → téléchargement (visiteurs distincts). */
export async function linkFunnel(userId: string, kind: 'project' | 'track', id: string) {
  uuid.parse(id);
  return withUser(userId, async (tx) => {
    const rows = await tx<{ linkId: string; label: string; revoked: boolean; opened: number; played: number; over30: number; complete: number; downloaded: number; saved: number }[]>`
      select l.id as "linkId", l.label, l.revoked_at is not null as revoked,
        (select count(distinct v.visitor)::int from link_views v where v.link_id = l.id) as opened,
        (select count(distinct s.visitor)::int from listen_sessions s where s.link_id = l.id) as played,
        (select count(distinct s.visitor)::int from listen_sessions s where s.link_id = l.id and s.listened_ms >= 30000) as over30,
        (select count(distinct s.visitor)::int from listen_sessions s where s.link_id = l.id and s.duration_ms > 0 and s.listened_ms >= s.duration_ms * ${COMPLETE}::numeric) as complete,
        (select count(distinct i.visitor)::int from interactions i where i.link_id = l.id and i.kind = 'download') as downloaded,
        (select count(*)::int from saves sv where sv.link_id = l.id) as saved
      from share_links l
      where ${kind === 'project' ? tx`l.project_id = ${id}` : tx`l.track_id = ${id}`}
      order by l.created_at desc`;
    return rows;
  });
}

export async function notifications(userId: string, limit = 20) {
  return withUser(userId, async (tx) => {
    const [{ unread }] = await tx<{ unread: number }[]>`select count(*)::int as unread from notifications where read_at is null`;
    const items = await tx<{ id: number; kind: string; trackId: string | null; projectId: string | null; title: string | null; actor: string | null; source: string | null; count: number; createdAt: Date; read: boolean }[]>`
      select n.id::int, n.kind, n.track_id as "trackId", n.project_id as "projectId", coalesce(t.title, p.title) as title,
             n.actor, n.source, n.count, n.created_at as "createdAt", n.read_at is not null as read
      from notifications n left join tracks t on t.id = n.track_id left join projects p on p.id = n.project_id
      order by n.created_at desc limit ${limit}`;
    return { unread, items: items.map((i) => ({ ...i, createdAt: i.createdAt.toISOString() })) };
  });
}

export async function markNotificationsRead(userId: string) {
  await withUser(userId, (tx) => tx`update notifications set read_at = now() where read_at is null`);
}
