import { fail, json, sameOrigin } from '@/lib/server/http';
import { resolveFromCookies, visitorId } from '@/lib/server/listener-http';
import { interact } from '@/lib/server/listening';

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!sameOrigin(req)) return fail(403, 'Origine refusée.');
  const { resolution: r } = await resolveFromCookies((await params).token);
  if (r.status !== 'ok') return fail(404, 'Introuvable.');
  if (!r.ctx.userId) return fail(401, 'Connecte-toi pour ajouter un favori.');
  const b = await req.json().catch(() => ({}));
  try {
    await interact(r.ctx, String(b.trackId), (await visitorId(true, b.pv))!, b.on ? 'favorite' : 'unfavorite');
  } catch {
    return fail(404, 'Introuvable.');
  }
  return json({ on: Boolean(b.on) });
}
