import Stripe from 'stripe';
import { env } from './env';

let cached: { key: string; client: Stripe } | null = null;

export class PaymentsOff extends Error { constructor() { super('Le paiement n’est pas encore configuré.'); } }

/** Client Stripe (mode test). STRIPE_API_BASE redirige vers le faux Stripe des tests. */
export function stripe(): Stripe {
  const e = env();
  if (!e.STRIPE_SECRET_KEY) throw new PaymentsOff();
  const key = `${e.STRIPE_SECRET_KEY}|${e.STRIPE_API_BASE ?? ''}`;
  if (cached?.key === key) return cached.client;
  const base = e.STRIPE_API_BASE ? new URL(e.STRIPE_API_BASE) : null;
  const client = new Stripe(e.STRIPE_SECRET_KEY, {
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: 'Sonikc' },
    ...(base ? { host: base.hostname, port: Number(base.port || (base.protocol === 'https:' ? 443 : 80)), protocol: base.protocol.replace(':', '') as 'http' | 'https' } : {}),
  });
  cached = { key, client };
  return client;
}

export const paymentsEnabled = () => Boolean(env().STRIPE_SECRET_KEY && env().STRIPE_WEBHOOK_SECRET);

/** Vérifie la signature d'un webhook (rejette aussi un envoi trop ancien : protection contre le rejeu). */
export function verifyWebhook(payload: string, signature: string | null): Stripe.Event {
  const e = env();
  if (!e.STRIPE_WEBHOOK_SECRET || !signature) throw new Error('signature manquante');
  return Stripe.webhooks.constructEvent(payload, signature, e.STRIPE_WEBHOOK_SECRET, 300);
}
