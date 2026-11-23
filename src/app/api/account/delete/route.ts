import { fail, json, sameOrigin } from '@/lib/server/http';
import { handleError } from '@/lib/server/errors';
import { clearSessionCookie, currentUser } from '@/lib/server/session';
import { deleteAccount } from '@/lib/server/account';

/** Suppression du compte : { confirm } = ton identifiant (ou ton email sans profil). */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail(403, 'Origine refusée.');
  const user = await currentUser();
  if (!user) return fail(401, 'Connexion requise.');
  try {
    const b = await req.json().catch(() => ({}));
    const r = await deleteAccount(user.id, b.confirm);
    await clearSessionCookie();
    return json(r);
  } catch (e) {
    return handleError(e);
  }
}
