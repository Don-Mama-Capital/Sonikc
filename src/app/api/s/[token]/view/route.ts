import { fail, json, sameOrigin } from '@/lib/server/http';
import { resolveFromCookies, visitorId } from '@/lib/server/listener-http';
import { myFavorites, recordView } from '@/lib/server/listening';
import { isSaved } from '@/lib/server/saves';

/** Ouverture de la page partagée : compte une ouverture et renvoie les favoris de l'auditeur connecté. */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!sameOrigin(req)) return fail(403, 'Origine refusée.');
  const { resolution: r } = await resolveFromCookies((await params).token);
  if (r.status !== 'ok') return fail(404, 'Introuvable.');
  const v = (await visitorId())!;
  await recordView(r.ctx, v);
  return json({ favorites: await myFavorites(r.ctx), loggedIn: Boolean(r.ctx.userId), saved: await isSaved(r.ctx) });
}
