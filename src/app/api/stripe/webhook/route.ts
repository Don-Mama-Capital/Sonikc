import { handleWebhook } from '@/lib/server/commerce';

/** Webhook Stripe : signature vérifiée sur le corps brut, chaque événement traité une seule fois. */
export async function POST(req: Request) {
  const payload = await req.text();
  if (payload.length > 1_000_000) return new Response('too large', { status: 413 });
  try {
    await handleWebhook(payload, req.headers.get('stripe-signature'));
    return new Response('ok');
  } catch (e) {
    const msg = (e as Error).message ?? '';
    // Signature absente, fausse ou trop ancienne : refus définitif. Autre erreur : 500, Stripe renverra l'événement.
    if (/signature|timestamp|No signatures found|webhook payload/i.test(msg) || (e as { type?: string }).type === 'StripeSignatureVerificationError') {
      return new Response('signature invalide', { status: 400 });
    }
    console.error('webhook stripe', e);
    return new Response('erreur', { status: 500 });
  }
}
