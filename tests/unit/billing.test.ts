import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asService, withUser } from '@/lib/server/db';
import { billingOverview, portalUrl, startSubscription, syncSubscription } from '@/lib/server/billing';
import { handleWebhook } from '@/lib/server/commerce';
import { createLink, updateShareSettings } from '@/lib/server/sharing';
import { resolveLink, sharedFile } from '@/lib/server/viewer';
import { linkToken } from '@/lib/server/share-token';
import { startUpload } from '@/lib/server/uploads';
import { LimitReached } from '@/lib/server/plans';
import { OFFERS } from '@/config/offers';
import { startFakeStripe, type FakeStripe } from '../../scripts/fake-stripe';
import { makeUser } from './helpers';

let fake: FakeStripe;
beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
  fake = await startFakeStripe({
    webhookSecret: 'whsec_test_fake',
    webhook: async (payload, sig) => { try { await handleWebhook(payload, sig); return 200; } catch { return 400; } },
  });
  process.env.STRIPE_API_BASE = fake.url;
});
afterAll(async () => { await fake.close(); });

const planOf = async (id: string) => (await asService((tx) => tx<{ plan: string }[]>`select plan from profiles where user_id = ${id}`))[0].plan;
const sessionOf = (url: string) => new URL(url).pathname.split('/').pop()!;
const subOf = async (id: string) => (await asService((tx) => tx<Record<string, any>[]>`select * from subscriptions where user_id = ${id}`))[0];

async function subscribe(userId: string, plan: 'pro' | 'studio' = 'pro', period: 'month' | 'year' = 'month', country = 'FR') {
  const { url } = await startSubscription(userId, { plan, period, country });
  const sid = sessionOf(url);
  await fake.pay(sid);
  return sid;
}

describe('Lot 5.2 — abonnements (faux Stripe)', () => {
  it('1-2. abonnement : essai sans carte, offre effective dès le webhook (moins de 30 s), prix TTC avec la TVA du pays', async () => {
    const u = await makeUser(undefined, 'free');
    const t0 = Date.now();
    const sid = await subscribe(u.id, 'pro', 'month', 'BE');
    expect(await planOf(u.id)).toBe('pro');
    expect(Date.now() - t0).toBeLessThan(30_000);
    const s = await subOf(u.id);
    expect(s).toMatchObject({ plan: 'pro', period: 'month', status: 'trialing', trial_used: true, country: 'BE' });
    const session = fake.state.sessions.get(sid)!;
    expect((session.subscription_data as { trial_period_days: string }).trial_period_days).toBe(String(OFFERS.pro.trialDays));
    expect(session.amount_total).toBe(OFFERS.pro.priceMonthCents); // TTC
    const line = (session.line_items as { tax_rates?: string[] }[])[0];
    const rate = fake.billing.taxRates.find((r) => r.id === line.tax_rates![0])!;
    expect(rate).toMatchObject({ percentage: 21, inclusive: true, country: 'BE' });
    // Les limites suivent : mot de passe désormais permis.
    const [t] = await asService((tx) => tx<{ id: string }[]>`insert into tracks (owner_id, title) values (${u.id}, 'x') returning id`);
    await expect(updateShareSettings(u.id, 'track', t.id, { visibility: 'public', password: 'motdepasse1' })).resolves.toBeTruthy();
    // Déjà abonné : pas de second abonnement.
    await expect(startSubscription(u.id, { plan: 'studio', period: 'month', country: 'FR' })).rejects.toThrow('déjà un abonnement');
    // Hors UE : pas de TVA.
    const v = await makeUser(undefined, 'free');
    const { url } = await startSubscription(v.id, { plan: 'studio', period: 'year', country: 'XX' });
    const s2 = fake.state.sessions.get(sessionOf(url))!;
    expect((s2.line_items as { tax_rates?: string[] }[])[0].tax_rates).toBeUndefined();
    expect(s2.amount_total).toBe(OFFERS.studio.priceYearCents);
  });

  it('1. essai gratuit une seule fois par compte', async () => {
    const u = await makeUser(undefined, 'free');
    await subscribe(u.id);
    await fake.deleteSubscription((await subOf(u.id)).subscription_id);
    expect(await planOf(u.id)).toBe('free');
    const sid = await subscribe(u.id);
    const s = fake.state.sessions.get(sid)!;
    expect((s.subscription_data as { trial_period_days?: string }).trial_period_days).toBeUndefined();
    expect((await subOf(u.id)).status).toBe('active');
    expect(await planOf(u.id)).toBe('pro');
  });

  it('3. changement d’offre et résiliation depuis le portail ; webhook rejoué, falsifié ou en retard sans effet', async () => {
    const u = await makeUser(undefined, 'free');
    await subscribe(u.id);
    const { url } = await portalUrl(u.id);
    expect(url).toContain('/portal/');
    const studioYear = [...fake.billing.prices.values()].find((p) => p.lookup_key === 'sonikc_studio_year')!;
    const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ price: studioYear.id as string }), redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(await planOf(u.id)).toBe('studio');
    expect((await subOf(u.id)).period).toBe('year');
    // Événement en retard (ancien état « pro ») : l'abonnement est relu chez Stripe, l'offre reste « studio ».
    const subId = (await subOf(u.id)).subscription_id;
    const stale = { id: subId, object: 'subscription', customer: (await subOf(u.id)).customer_id, status: 'trialing', items: { data: [] } };
    expect(await fake.emitEvent('customer.subscription.updated', stale)).toBe(200);
    expect(await planOf(u.id)).toBe('studio');
    // Rejoué : ignoré ; falsifié : refusé.
    const ev = fake.state.events.filter((e) => e.type === 'customer.subscription.updated').at(-1)!;
    expect(await fake.replay(ev.id as string)).toBe(200);
    expect(await fake.replay(ev.id as string, { tamper: true })).toBe(400);
    // Résiliation en fin de période : l'offre reste jusqu'au bout, puis retour à l'offre gratuite.
    await fetch(url, { method: 'POST', body: new URLSearchParams({ cancel: '1' }), redirect: 'manual' });
    expect(await planOf(u.id)).toBe('studio');
    expect((await subOf(u.id)).cancel_at_period_end).toBe(true);
    await fake.deleteSubscription(subId);
    expect(await planOf(u.id)).toBe('free');
  });

  it('4. impayé : délai de grâce, puis retour à l’offre gratuite ; données gardées, écoute et téléchargement possibles, ajouts bloqués', async () => {
    const u = await makeUser(undefined, 'free');
    await subscribe(u.id);
    const subId = (await subOf(u.id)).subscription_id;
    // 30 morceaux (au-delà de la limite gratuite), dont un public, en téléchargement, protégé par mot de passe (offre payante).
    await asService((tx) => tx`insert into tracks (owner_id, title) select ${u.id}, 'b' || g from generate_series(1, 29) g`);
    const shared = await asService(async (tx) => {
      const [t] = await tx<{ id: string }[]>`insert into tracks (owner_id, title, allow_download) values (${u.id}, 'Partagé', true) returning id`;
      const [v] = await tx<{ id: string }[]>`insert into track_versions (track_id, owner_id, version_no, label, status, original_filename, original_key, preview_key, duration_ms)
        values (${t.id}, ${u.id}, 1, 'v1', 'ready', 'b.wav', ${`o/${t.id}`}, ${`p/${t.id}`}, 90000) returning id`;
      await tx`update tracks set current_version_id = ${v.id} where id = ${t.id}`;
      return { trackId: t.id, versionId: v.id };
    });
    await updateShareSettings(u.id, 'track', shared.trackId, { visibility: 'public' });
    const link = await createLink(u.id, 'track', shared.trackId, 'Insta');
    await fake.updateSubscription(subId, { status: 'past_due' });
    expect(await planOf(u.id)).toBe('pro');
    await fake.updateSubscription(subId, { status: 'unpaid' });
    expect(await planOf(u.id)).toBe('free');
    const ov = await billingOverview(u.id);
    expect(ov.usage.tracks).toBe(30);
    expect(ov.plan).toBe('free');
    await expect(startUpload(u.id, { filename: 'n.wav', size: 100 })).rejects.toThrow(LimitReached);
    // Après le retour à l'offre gratuite : le lien marche toujours, écoute et téléchargement compris.
    const listener = await makeUser();
    const r = await resolveLink(linkToken(link.id), listener.id, undefined);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(await sharedFile(r.ctx, r.meta, shared.versionId, 'preview')).toMatchObject({ key: `p/${shared.trackId}` });
    expect(await sharedFile(r.ctx, r.meta, shared.versionId, 'original')).toMatchObject({ key: `o/${shared.trackId}` });
  });

  it('l’offre ne se change que par l’accès « paiement » (jamais par l’app)', async () => {
    const u = await makeUser(undefined, 'free');
    await expect(withUser(u.id, (tx) => tx`update profiles set plan = 'studio' where user_id = ${u.id}`)).rejects.toThrow(/permission denied/);
    await expect(withUser(u.id, (tx) => tx`insert into subscriptions (user_id, customer_id) values (${u.id}, 'cus_x')`)).rejects.toThrow(/permission denied/);
    expect(await syncSubscription('sub_inconnu').catch(() => 'erreur')).toBe('erreur');
  });
});
