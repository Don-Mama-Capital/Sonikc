import { fail, json, sameOrigin } from '@/lib/server/http';
import { resolveFromCookies, visitorId } from '@/lib/server/listener-http';
import { listenBeat, listenStart } from '@/lib/server/listening';

/** Début d'écoute et battements (toutes les 5 s, et à la pause ou à la fermeture via sendBeacon). */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!sameOrigin(req)) return fail(403, 'Origine refusée.');
  const { resolution: r } = await resolveFromCookies((await params).token);
  if (r.status !== 'ok') return fail(404, 'Introuvable.');
  let b: Record<string, unknown> = {};
  try { b = JSON.parse(await req.text()); } catch { return fail(400, 'Données invalides.'); }
  const v = (await visitorId())!;
  try {
    if (b.action === 'start') return json(await listenStart(r.ctx, String(b.trackId), v));
    if (b.action === 'beat') return json({ listenedMs: await listenBeat(r.ctx, String(b.sessionId), v, Number(b.playedMs)) });
  } catch {
    return fail(404, 'Introuvable.');
  }
  return fail(400, 'Action inconnue.');
}
