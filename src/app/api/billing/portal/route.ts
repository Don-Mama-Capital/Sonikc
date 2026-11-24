import { route } from '@/lib/server/route';
import { portalUrl } from '@/lib/server/billing';

/** Portail Stripe : changer d'offre, moyen de paiement, factures, résiliation. */
export const POST = route(({ user }) => portalUrl(user.id));
