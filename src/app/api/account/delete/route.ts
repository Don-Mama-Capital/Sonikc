import { fail, json, sameOrigin } from '@/lib/server/http';
import { handleError } from '@/lib/server/errors';
import { clearSessionCookie, currentUser } from '@/lib/server/session';
import { MoneyOwed, deleteAccount } from '@/lib/server/account';

/** Suppression du compte : { confirm } = ton identifiant (ou ton email sans profil) ; { renounce } = renoncer à l'argent dû. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail(403, 'Origine refusée.');
  const user = await currentUser();
  if (!user) return fail(401, 'Connexion requise.');
  try {
    const b = await req.json().catch(() => ({}));
    const r = await deleteAccount(user.id, b.confirm, { renounce: b.renounce === true });
    await clearSessionCookie();
    return json(r);
  } catch (e) {
    if (e instanceof MoneyOwed) return json({ error: e.message, owedCents: e.cents }, 409);
    return handleError(e);
  }
}
