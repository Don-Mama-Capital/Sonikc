import { resolveFromCookies } from '@/lib/server/listener-http';
import { verifySharedAudio } from '@/lib/server/share-token';
import { sharedFile } from '@/lib/server/viewer';
import { store } from '@/lib/server/storage';

const notFound = () => new Response('Introuvable.', { status: 404 });

/** Audio d'un morceau partagé : adresse signée et liée au lien, droits revérifiés à chaque requête. */
export async function GET(req: Request, { params }: { params: Promise<{ token: string; versionId: string }> }) {
  const { token, versionId } = await params;
  const q = new URL(req.url).searchParams;
  const { resolution: r } = await resolveFromCookies(token);
  if (r.status !== 'ok') return notFound();
  if (!/^[0-9a-f-]{36}$/.test(versionId) || !verifySharedAudio(r.meta.linkId, versionId, q.get('exp'), q.get('sig'))) {
    return new Response('Adresse expirée ou invalide.', { status: 403 });
  }
  const f = await sharedFile(r.ctx, r.meta, versionId, 'preview');
  if (!f) return notFound();
  try {
    const res = await store().readResponse(f.key, req, null);
    res.headers.set('cache-control', 'private, no-store');
    return res;
  } catch {
    return notFound();
  }
}
