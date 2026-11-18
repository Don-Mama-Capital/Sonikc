import { resolveFromCookies, visitorId } from '@/lib/server/listener-http';
import { interact } from '@/lib/server/listening';
import { sharedFile } from '@/lib/server/viewer';
import { store } from '@/lib/server/storage';

/** Téléchargement du fichier d'origine, seulement si le propriétaire l'a autorisé. */
export async function GET(req: Request, { params }: { params: Promise<{ token: string; versionId: string }> }) {
  const { token, versionId } = await params;
  const { resolution: r } = await resolveFromCookies(token);
  if (r.status !== 'ok' || !/^[0-9a-f-]{36}$/.test(versionId)) return new Response('Introuvable.', { status: 404 });
  const f = await sharedFile(r.ctx, r.meta, versionId, 'original');
  if (!f) return new Response('Téléchargement non autorisé.', { status: 403 });
  // Une requête partielle (reprise) ne compte pas un deuxième téléchargement.
  if (!req.headers.get('range')) await interact(r.ctx, f.trackId, (await visitorId())!, 'download').catch(() => false);
  return store().readResponse(f.key, req, f.filename);
}
