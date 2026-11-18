import { z } from 'zod';
import { withUser, withViewer, type ViewerCtx } from './db';
import { linkToken } from './share-token';
import { linkMetas, loadShared, resolveWithMeta, unlockCookieName } from './viewer';

export const RECEIVED_PAGE = 30;

/**
 * « Reçus » (lot 2.4) : un compte connecté enregistre un partage. On garde le lien, jamais une copie :
 * chaque affichage repasse par la résolution du lien, donc le producteur garde la main (révocation,
 * niveau, invitation, mot de passe).
 */

export async function isSaved(ctx: ViewerCtx) {
  if (!ctx.userId) return false;
  return withViewer(ctx, async (tx) => (await tx`select 1 from saves where user_id = ${ctx.userId} and link_id = ${ctx.linkId}`).length > 0);
}

export async function saveLink(ctx: ViewerCtx) {
  return withViewer(ctx, async (tx) => (await tx<{ ok: boolean }[]>`select app.save_link() as ok`)[0].ok);
}

export async function unsaveLink(userId: string, linkId: string) {
  z.string().uuid().parse(linkId);
  await withUser(userId, (tx) => tx`delete from saves where link_id = ${linkId}`);
}

export type Received =
  | { id: string; linkId: string; savedAt: string; token: string; available: true; view: NonNullable<Awaited<ReturnType<typeof loadShared>>> }
  | { id: string; linkId: string; savedAt: string; token: string; available: false; reason: 'gone' | 'password' };

/**
 * Les partages enregistrés par un compte, par pages de 30, chacun relu avec ses droits actuels :
 * une requête pour authentifier tous les liens de la page, puis une lecture (RLS) par partage.
 */
export async function listReceived(userId: string, cookie: (name: string) => string | undefined, page = 0) {
  const p = Math.max(0, Math.floor(Number(page) || 0));
  const rows = await withUser(userId, (tx) => tx<{ id: string; linkId: string; savedAt: Date }[]>`
    select id, link_id as "linkId", created_at as "savedAt" from saves where user_id = ${userId}
    order by created_at desc, id limit ${RECEIVED_PAGE + 1} offset ${p * RECEIVED_PAGE}`);
  const hasMore = rows.length > RECEIVED_PAGE;
  const pageRows = rows.slice(0, RECEIVED_PAGE);
  const metas = await linkMetas(pageRows.map((r) => r.linkId));
  const items: Received[] = [];
  for (const r of pageRows) {
    const base = { id: r.id, linkId: r.linkId, savedAt: r.savedAt.toISOString(), token: linkToken(r.linkId) };
    const meta = metas.get(r.linkId);
    const res = meta ? await resolveWithMeta(meta, userId, cookie(unlockCookieName(r.linkId)), false) : { status: 'not_found' as const };
    if (res.status === 'password') { items.push({ ...base, available: false, reason: 'password' }); continue; }
    // loadShared lit avec les droits de l'auditeur : rien n'est rendu si la base refuse.
    const view = res.status === 'ok' ? await loadShared(base.token, res) : null;
    items.push(view ? { ...base, available: true, view } : { ...base, available: false, reason: 'gone' });
  }
  return { items, hasMore, page: p };
}
