import { orderFile, verifyOrderFile } from '@/lib/server/commerce';
import { store } from '@/lib/server/storage';

/** Fichier d'une commande : adresse signée qui expire (2 h), droits revérifiés à chaque requête. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; kind: string }> }) {
  const { id, kind } = await params;
  const q = new URL(req.url).searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id) || !verifyOrderFile(id, kind, q.get('exp'), q.get('sig'))) return new Response('Adresse expirée ou invalide.', { status: 403 });
  const f = await orderFile(id, kind);
  if (!f) return new Response('Introuvable.', { status: 404 });
  const res = await store().readResponse(f.key, req, f.filename);
  res.headers.set('cache-control', 'private, no-store');
  return res;
}
