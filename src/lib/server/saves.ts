import { z } from 'zod';
import { withUser, withViewer, type ViewerCtx } from './db';
import { linkToken } from './share-token';
import { loadShared, resolveLink, unlockCookieName } from './viewer';

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
  | { id: string; linkId: string; savedAt: string; available: true; token: string; view: NonNullable<Awaited<ReturnType<typeof loadShared>>> }
  | { id: string; linkId: string; savedAt: string; available: false; reason: 'gone' | 'password' };

/** Les partages enregistrés par un compte, chacun relu avec ses droits actuels. */
export async function listReceived(userId: string, cookie: (name: string) => string | undefined): Promise<Received[]> {
  const rows = await withUser(userId, (tx) => tx<{ id: string; linkId: string; savedAt: Date }[]>`
    select id, link_id as "linkId", created_at as "savedAt" from saves where user_id = ${userId} order by created_at desc limit 200`);
  const out: Received[] = [];
  for (const r of rows) {
    const base = { id: r.id, linkId: r.linkId, savedAt: r.savedAt.toISOString() };
    const token = linkToken(r.linkId);
    const res = await resolveLink(token, userId, cookie(unlockCookieName(r.linkId)));
    if (res.status === 'password') { out.push({ ...base, available: false, reason: 'password' }); continue; }
    const view = res.status === 'ok' ? await loadShared(token, res) : null;
    out.push(view ? { ...base, available: true, token, view } : { ...base, available: false, reason: 'gone' });
  }
  return out;
}
