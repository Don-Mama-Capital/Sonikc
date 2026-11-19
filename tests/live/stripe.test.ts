import { describe, expect, it } from 'vitest';
import { asService } from '@/lib/server/db';
import { updateShareSettings } from '@/lib/server/sharing';
import { listTemplates } from '@/lib/server/storefront';
import { startCheckout, startOnboarding } from '@/lib/server/commerce';
import { stripe, verifyWebhook } from '@/lib/server/stripe';
import Stripe from 'stripe';
import { makeUser } from '../unit/helpers';

/**
 * Contre la vraie API Stripe, en mode test : vérifie que les appels de Sonikc (mêmes fonctions qu'en production)
 * sont acceptés tels quels. Le parcours complet navigateur se fait avec le faux Stripe (recette).
 */
const key = process.env.STRIPE_SECRET_KEY ?? '';
process.env.STRIPE_WEBHOOK_SECRET ??= 'whsec_live_smoke_local_only';

describe.skipIf(!key)('Stripe réel (mode test)', () => {
  it('la clé est une clé de test', () => {
    expect(key).toMatch(/^(sk|rk)_test_/);
  });

  it('Checkout : la session de Sonikc est acceptée et lisible avec les mêmes options', async () => {
    const u = await makeUser();
    const trackId = await asService(async (tx) => {
      const [t] = await tx<{ id: string }[]>`insert into tracks (owner_id, title) values (${u.id}, 'Smoke test') returning id`;
      const [v] = await tx<{ id: string }[]>`insert into track_versions (track_id, owner_id, version_no, label, status, original_filename, original_key, preview_key, format)
        values (${t.id}, ${u.id}, 1, 'v1', 'ready', 's.wav', ${`o/${t.id}`}, ${`p/${t.id}`}, 'wav') returning id`;
      await tx`update tracks set current_version_id = ${v.id} where id = ${t.id}`;
      return t.id;
    });
    await updateShareSettings(u.id, 'track', trackId, { visibility: 'for_sale' });
    const [basic] = await listTemplates(u.id);
    const c = await startCheckout({ trackId, templateId: basic.id, country: 'BE', email: 'smoke@example.com' }, { buyerUserId: null, ip: '203.0.113.7' });
    expect(c.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const [o] = await asService((tx) => tx<{ session: string }[]>`select checkout_session_id as session from orders where id = ${c.orderId}`);
    const s = await stripe().checkout.sessions.retrieve(o.session, { expand: ['payment_intent.latest_charge.balance_transaction'] });
    expect(s).toMatchObject({ amount_total: 2900 + 609, currency: 'eur', status: 'open', metadata: { order_id: c.orderId } });
    await stripe().checkout.sessions.expire(o.session);
  });

  it('Paiement, frais, remboursement idempotent (mêmes options que Sonikc)', async () => {
    const pi = await stripe().paymentIntents.create({ amount: 3480, currency: 'eur', payment_method: 'pm_card_visa', confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' }, transfer_group: 'smoke', metadata: { order_id: 'smoke' } });
    const full = await stripe().paymentIntents.retrieve(pi.id, { expand: ['latest_charge.balance_transaction'] });
    const charge = full.latest_charge as Stripe.Charge;
    expect((charge.balance_transaction as Stripe.BalanceTransaction).fee).toBeGreaterThan(0);
    expect(charge.payment_method_details?.card?.country).toMatch(/^[A-Z]{2}$/);
    const k = `smoke-refund-${pi.id}`;
    const r1 = await stripe().refunds.create({ payment_intent: pi.id, metadata: { order_id: 'smoke' } }, { idempotencyKey: k });
    const r2 = await stripe().refunds.create({ payment_intent: pi.id, metadata: { order_id: 'smoke' } }, { idempotencyKey: k });
    expect(r2.id).toBe(r1.id);
  });

  it('Connect Express : compte et lien d’activation créés par Sonikc', async () => {
    const u = await makeUser();
    const { url } = await startOnboarding(u.id);
    expect(url).toMatch(/^https:\/\/connect\.stripe\.com\//);
    const [a] = await asService((tx) => tx<{ id: string }[]>`select account_id as id from stripe_accounts where user_id = ${u.id}`);
    const acct = await stripe().accounts.retrieve(a.id);
    expect(acct.type).toBe('express');
    await stripe().accounts.del(a.id);
  });

  it('Signature des webhooks : celle de Stripe est acceptée, une fausse refusée', () => {
    const payload = JSON.stringify({ id: 'evt_smoke', object: 'event', type: 'ping' });
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
    expect(verifyWebhook(payload, header).id).toBe('evt_smoke');
    expect(() => verifyWebhook(payload, header.replace(/v1=./, 'v1=0'))).toThrow();
  });
});
