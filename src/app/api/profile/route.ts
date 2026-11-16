import { createProfile, ProfileError } from '@/lib/server/auth';
import { fail, json, sameOrigin } from '@/lib/server/http';
import { currentUser } from '@/lib/server/session';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail(403, 'Origine refusée.');
  const user = await currentUser();
  if (!user) return fail(401, 'Connexion requise.');
  const body = await req.json().catch(() => ({}));
  try {
    const p = await createProfile(user.id, String(body.handle ?? ''), String(body.displayName ?? ''));
    return json({ ok: true, ...p });
  } catch (e) {
    if (e instanceof ProfileError) return fail(400, e.message, { field: e.field });
    throw e;
  }
}

/** Réglages du profil (pour l'instant : notation des tonalités, dièses ou bémols). */
export async function PATCH(req: Request) {
  if (!sameOrigin(req)) return fail(403, 'Origine refusée.');
  const user = await currentUser();
  if (!user?.handle) return fail(401, 'Connexion requise.');
  const body = await req.json().catch(() => ({}));
  if (body.keyNotation !== 'sharps' && body.keyNotation !== 'flats') return fail(400, 'Notation invalide.');
  const { withUser } = await import('@/lib/server/db');
  await withUser(user.id, (tx) => tx`update profiles set key_notation = ${body.keyNotation} where user_id = ${user.id}`);
  return json({ ok: true });
}
