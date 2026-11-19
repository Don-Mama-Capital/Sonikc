import { body, route } from '@/lib/server/route';
import { payoutAccount, refreshAccount, startOnboarding } from '@/lib/server/commerce';

/** État du compte de reversement (relu chez Stripe s'il existe). */
export const GET = route(async ({ user }) => {
  if (await payoutAccount(user.id)) await refreshAccount(user.id);
  return { account: await payoutAccount(user.id) };
});
/** Ouvre (ou reprend) l'activation des reversements chez Stripe. */
export const POST = route(async ({ req, user }) => startOnboarding(user.id, (await body(req)).country ?? 'FR'));
