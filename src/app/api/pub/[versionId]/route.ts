import { publicPreviewKey, verifyPublicAudio } from '@/lib/server/storefront';
import { store } from '@/lib/server/storage';

const notFound = () => new Response('Introuvable.', { status: 404 });

/** Extrait d'écoute de la page publique : adresse signée qui expire, droits revérifiés par la base à chaque requête. */
export async function GET(req: Request, { params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params;
  const q = new URL(req.url).searchParams;
  if (!/^[0-9a-f-]{36}$/.test(versionId) || !verifyPublicAudio(versionId, q.get('exp'), q.get('sig'))) {
    return new Response('Adresse expirée ou invalide.', { status: 403 });
  }
  const key = await publicPreviewKey(versionId);
  if (!key) return notFound();
  try {
    const res = await store().readResponse(key, req, null);
    res.headers.set('cache-control', 'private, no-store');
    return res;
  } catch {
    return notFound();
  }
}
