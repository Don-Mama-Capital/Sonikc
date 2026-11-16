import { store, verifySignedGet } from '@/lib/server/storage';

/** Sert un fichier privé si l'URL signée par l'app est valide (pilote local) ou redirige vers une URL signée Supabase. */
export async function GET(req: Request, ctx: { params: Promise<{ key: string[] }> }) {
  const { key: parts } = await ctx.params;
  const key = parts.map(decodeURIComponent).join('/');
  const url = new URL(req.url);
  const dl = url.searchParams.get('dl');
  if (!verifySignedGet(key, url.searchParams.get('exp'), url.searchParams.get('sig'), dl)) {
    return new Response('Lien expiré ou invalide.', { status: 403 });
  }
  try {
    return await store().readResponse(key, req, dl);
  } catch {
    return new Response('Introuvable.', { status: 404 });
  }
}
