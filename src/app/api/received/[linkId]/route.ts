import { fail, json, sameOrigin } from '@/lib/server/http';
import { currentUser } from '@/lib/server/session';
import { unsaveLink } from '@/lib/server/saves';

/** Retirer un partage de « Reçus » (ouvert aux comptes sans profil de producteur). */
export async function DELETE(req: Request, { params }: { params: Promise<{ linkId: string }> }) {
  if (!sameOrigin(req)) return fail(403, 'Origine refusée.');
  const user = await currentUser();
  if (!user) return fail(401, 'Connexion requise.');
  try { await unsaveLink(user.id, (await params).linkId); } catch { return fail(400, 'Données invalides.'); }
  return json({ ok: true });
}
