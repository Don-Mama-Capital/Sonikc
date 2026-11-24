import { body, route } from '@/lib/server/route';
import { startSubscription } from '@/lib/server/billing';

/** Début d'abonnement : { plan, period, country } → adresse de la page de paiement Stripe. */
export const POST = route(async ({ req, user }) => startSubscription(user.id, await body(req)));
