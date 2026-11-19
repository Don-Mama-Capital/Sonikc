import { fail, json, sameOrigin } from '@/lib/server/http';
import { handleError } from '@/lib/server/errors';
import { clientIp, currentUser } from '@/lib/server/session';
import { startCheckout } from '@/lib/server/commerce';
import { paymentsEnabled } from '@/lib/server/stripe';

/** Début d'un achat (sans compte obligatoire) : rend l'adresse de la page de paiement Stripe. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail(403, 'Origine refusée.');
  if (!paymentsEnabled()) return fail(503, 'Le paiement n’est pas encore ouvert.');
  try {
    const user = await currentUser();
    const body = await req.json().catch(() => ({}));
    return json(await startCheckout(body, { buyerUserId: user?.id ?? null, ip: await clientIp() }));
  } catch (e) {
    return handleError(e);
  }
}
