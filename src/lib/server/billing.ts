import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type Stripe from 'stripe';
import { asPayments, withUser, type Tx } from './db';
import { Invalid } from './library';
import { env } from './env';
import { stripe } from './stripe';
import { GB, emailsThisMonth, storageUsed } from './plans';
import { OFFERS, FREE, isOfferId, limitsOf, offerOf, type OfferId } from '@/config/offers';
import { EU_VAT, OUTSIDE_EU } from '@/config/vat';
import { assertInvoiceReady } from '@/config/company';

/**
 * Lot 5.2 — abonnements Stripe Billing (mode test). Les prix viennent du fichier des offres (TTC) ;
 * produits, prix, taux de TVA et configuration du portail sont créés au besoin chez Stripe, repérés par clé.
 * L'offre en vigueur (profiles.plan) est recalculée à chaque événement depuis TOUS les abonnements du client relus
 * chez Stripe, sous verrou par client : l'ordre d'arrivée des webhooks n'a pas d'importance, et deux événements
 * rapprochés ne peuvent pas s'écraser dans le désordre.
 */

export type Period = 'month' | 'year';
const PAID = ['pro', 'studio'] as const;
type PaidOffer = (typeof PAID)[number];
const paidSchema = z.enum(PAID);
const periodSchema = z.enum(['month', 'year']);
// Statuts qui donnent droit à l'offre : essai, actif, et impayé en cours de relance (délai de grâce).
const ENTITLED = new Set(['trialing', 'active', 'past_due']);
// Statuts d'un abonnement encore vivant chez Stripe (on n'en ouvre pas un second).
const LIVE = new Set(['trialing', 'active', 'past_due', 'incomplete', 'unpaid', 'paused']);

const lookupKey = (plan: PaidOffer, period: Period) => `sonikc_${plan}_${period}`;

/** Prix Stripe d'une offre (créé une fois, repéré par sa clé ; un prix changé dans le fichier crée un nouveau prix). */
export async function ensurePrice(plan: PaidOffer, period: Period): Promise<Stripe.Price> {
  const offer = OFFERS[plan];
  const amount = period === 'month' ? offer.priceMonthCents : offer.priceYearCents;
  const key = lookupKey(plan, period);
  const found = await stripe().prices.list({ lookup_keys: [key], active: true, limit: 1 });
  const p = found.data[0];
  if (p && p.unit_amount === amount && p.currency === 'eur' && p.tax_behavior === 'inclusive') return p;
  const products = await stripe().products.list({ active: true, limit: 100 });
  const product = products.data.find((x) => x.metadata?.sonikc_plan === plan) ?? await stripe().products.create({ name: `Sonikc ${offer.name}`, metadata: { sonikc_plan: plan } },
    { idempotencyKey: `product-${plan}` });
  return stripe().prices.create({
    product: product.id, currency: 'eur', unit_amount: amount, tax_behavior: 'inclusive',
    recurring: { interval: period }, lookup_key: key, transfer_lookup_key: true, metadata: { sonikc_plan: plan, sonikc_period: period },
  }, { idempotencyKey: `price-${key}-${amount}` });
}

/** Taux de TVA (inclus dans le prix) du pays de l'abonné ; aucun hors UE. */
async function taxRateFor(country: string): Promise<string | null> {
  const rate = EU_VAT[country]?.rate;
  if (!rate) return null;
  const list = await stripe().taxRates.list({ active: true, inclusive: true, limit: 100 });
  const hit = list.data.find((t) => t.metadata?.sonikc_country === country && t.percentage === rate);
  if (hit) return hit.id;
  const t = await stripe().taxRates.create({
    display_name: 'TVA', percentage: rate, inclusive: true, country, jurisdiction: country, metadata: { sonikc_country: country },
  }, { idempotencyKey: `taxrate-${country}-${rate}` });
  return t.id;
}

async function ensureCustomer(userId: string) {
  const [row] = await asPayments((tx) => tx<{ customerId: string }[]>`select customer_id as "customerId" from subscriptions where user_id = ${userId}`);
  if (row) return row.customerId;
  const [u] = await asPayments((tx) => tx<{ email: string }[]>`select email from users where id = ${userId}`);
  const c = await stripe().customers.create({ email: u.email, metadata: { user_id: userId } }, { idempotencyKey: `customer-${userId}` });
  await asPayments((tx) => tx`insert into subscriptions (user_id, customer_id) values (${userId}, ${c.id}) on conflict (user_id) do nothing`);
  const [again] = await asPayments((tx) => tx<{ customerId: string }[]>`select customer_id as "customerId" from subscriptions where user_id = ${userId}`);
  return again.customerId;
}

const checkoutSchema = z.object({
  plan: paidSchema,
  period: periodSchema,
  country: z.string().refine((c) => c === OUTSIDE_EU || Object.hasOwn(EU_VAT, c), 'Pays invalide.'),
});

/** Début d'abonnement : page de paiement Stripe ; essai sans carte si le compte n'a jamais essayé. */
export async function startSubscription(userId: string, raw: unknown) {
  const input = checkoutSchema.parse(raw);
  assertInvoiceReady();
  const customer = await ensureCustomer(userId);
  // Stripe fait foi (l'état local peut avoir un webhook de retard, ou un autre onglet) : un seul abonnement vivant.
  const existing = (await stripe().subscriptions.list({ customer, status: 'all', limit: 100 })).data;
  if (existing.some((x) => LIVE.has(x.status))) throw new Invalid('Tu as déjà un abonnement : change d’offre depuis « Gérer mon abonnement ».');
  const price = await ensurePrice(input.plan, input.period);
  const tax = await taxRateFor(input.country);
  // Une seule page de paiement ouverte à la fois, sous verrou : la précédente est fermée avant d'en ouvrir une autre
  // (deux onglets ne peuvent pas aboutir à deux abonnements payés).
  return asPayments(async (tx) => {
    const [row] = await tx<{ trialUsed: boolean; open: string | null }[]>`select trial_used as "trialUsed", checkout_session_id as open
      from subscriptions where user_id = ${userId} for update`;
    if (row.open) {
      // Une page déjà payée a créé son abonnement chez Stripe : il aurait été vu ci-dessus s'il était encore vivant.
      const prev = await stripe().checkout.sessions.retrieve(row.open).catch(() => null);
      if (prev?.status === 'open') await stripe().checkout.sessions.expire(row.open);
    }
    const marks = await marksOf(tx, userId);
    const [{ seen }] = await tx<{ seen: boolean }[]>`select exists (select 1 from trial_marks where mark = any(${marks})) as seen`;
    const trialUsed = row.trialUsed || seen || existing.some((x) => x.trial_start);
    const trialDays = trialUsed ? 0 : OFFERS[input.plan].trialDays;
    const session = await stripe().checkout.sessions.create({
      mode: 'subscription', customer, locale: 'fr', client_reference_id: userId,
      line_items: [{ price: price.id, quantity: 1, ...(tax ? { tax_rates: [tax] } : {}) }],
      // Essai sans carte : à la fin de l'essai sans moyen de paiement, l'abonnement s'arrête (retour à l'offre gratuite).
      ...(trialDays ? { payment_method_collection: 'if_required' as const } : {}),
      subscription_data: {
        metadata: { user_id: userId, sonikc_plan: input.plan },
        ...(trialDays ? { trial_period_days: trialDays, trial_settings: { end_behavior: { missing_payment_method: 'cancel' as const } } } : {}),
      },
      metadata: { user_id: userId, kind: 'subscription' },
      success_url: `${env().APP_URL}/app/offre?abonnement=ok`,
      cancel_url: `${env().APP_URL}/app/offre`,
    }); // pas de clé d'idempotence : chaque clic ouvre une session à jour (essai déjà utilisé, pays…)
    await tx`update subscriptions set checkout_session_id = ${session.id}, country = ${input.country === OUTSIDE_EU ? null : input.country},
      updated_at = now() where user_id = ${userId}`;
    return { url: session.url! };
  });
}

/** Portail Stripe : changer d'offre ou de période, moyen de paiement, factures, résiliation (en fin de période). */
async function ensurePortalConfig() {
  const list = await stripe().billingPortal.configurations.list({ active: true, limit: 100 });
  const prices = await Promise.all(PAID.flatMap((p) => (['month', 'year'] as const).map((per) => ensurePrice(p, per))));
  const ids = prices.map((p) => p.id).sort().join(',');
  const hit = list.data.find((c) => c.metadata?.sonikc === ids);
  if (hit) return hit.id;
  const byProduct = new Map<string, string[]>();
  for (const p of prices) {
    const prod = typeof p.product === 'string' ? p.product : p.product.id;
    byProduct.set(prod, [...(byProduct.get(prod) ?? []), p.id]);
  }
  const c = await stripe().billingPortal.configurations.create({
    business_profile: { headline: 'Ton abonnement Sonikc' },
    features: {
      subscription_update: { enabled: true, default_allowed_updates: ['price'], proration_behavior: 'create_prorations',
        products: [...byProduct].map(([product, p]) => ({ product, prices: p })) },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
    },
    metadata: { sonikc: ids },
  });
  return c.id;
}

export async function portalUrl(userId: string) {
  const [row] = await asPayments((tx) => tx<{ customerId: string }[]>`select customer_id as "customerId" from subscriptions where user_id = ${userId}`);
  if (!row) throw new Invalid('Aucun abonnement à gérer.');
  const s = await stripe().billingPortal.sessions.create({ customer: row.customerId, configuration: await ensurePortalConfig(), return_url: `${env().APP_URL}/app/offre`, locale: 'fr' });
  return { url: s.url };
}

/** Offre que donne un abonnement Stripe (prix reconnu par sa clé ou ses métadonnées). */
function planOfSubscription(s: Stripe.Subscription): { plan: PaidOffer | null; period: Period | null } {
  const price = s.items.data[0]?.price;
  const plan = price?.metadata?.sonikc_plan ?? s.metadata?.sonikc_plan;
  const period = price?.recurring?.interval === 'year' ? 'year' : price?.recurring?.interval === 'month' ? 'month' : null;
  return { plan: plan === 'pro' || plan === 'studio' ? plan : null, period };
}

/**
 * Essai gratuit une fois par personne : empreintes HMAC (irréversibles) de l'email normalisé et de l'identifiant Google.
 * Gmail : sans points ni « +étiquette » ; autres adresses : sans « +étiquette ».
 */
export function normalizeEmail(email: string) {
  const [rawLocal, rawDomain = ''] = email.trim().toLowerCase().split('@');
  let local = rawLocal.split('+')[0];
  let domain = rawDomain;
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}
function trialMarks(email: string, googleSub: string | null) {
  const mark = (v: string) => createHmac('sha256', env().APP_SECRET).update(`sonikc-trial:${v}`).digest('hex');
  return [mark(`email:${normalizeEmail(email)}`), ...(googleSub ? [mark(`google:${googleSub}`)] : [])];
}
async function marksOf(tx: Tx, userId: string) {
  const [u] = await tx<{ email: string; googleSub: string | null }[]>`select email, google_sub as "googleSub" from users where id = ${userId}`;
  return u ? trialMarks(u.email, u.googleSub) : [];
}

const PLAN_RANK: Record<string, number> = { pro: 1, studio: 2 };

/**
 * Synchronise un client depuis Stripe : relit tous ses abonnements (sous verrou par client, donc à jour et dans l'ordre)
 * et retient celui qui donne droit à la meilleure offre, sinon le plus récent. Rend l'offre en vigueur.
 */
export async function syncCustomer(customer: string): Promise<OfferId | null> {
  return asPayments(async (tx) => {
    const [row] = await tx<{ userId: string }[]>`select user_id as "userId" from subscriptions where customer_id = ${customer} for update`;
    if (!row) return null; // client inconnu : rien à faire
    const all = (await stripe().subscriptions.list({ customer, status: 'all', limit: 100 })).data;
    const scored = all.map((x) => ({ x, ...planOfSubscription(x) }))
      .map((v) => ({ ...v, entitled: Boolean(v.plan && ENTITLED.has(v.x.status)) }))
      .sort((a, b) => Number(b.entitled) - Number(a.entitled) || (PLAN_RANK[b.plan ?? ''] ?? 0) - (PLAN_RANK[a.plan ?? ''] ?? 0) || b.x.created - a.x.created);
    const best = scored[0];
    const trialUsed = all.some((x) => x.trial_start);
    if (trialUsed) {
      const marks = await marksOf(tx, row.userId);
      if (marks.length) await tx`insert into trial_marks ${tx(marks.map((mark) => ({ mark })))} on conflict (mark) do nothing`;
    }
    if (!best) {
      await tx`update subscriptions set trial_used = trial_used or ${trialUsed}, updated_at = now() where user_id = ${row.userId}`;
      await tx`update profiles set plan = ${FREE} where user_id = ${row.userId}`;
      return FREE;
    }
    const s = best.x;
    const item = s.items.data[0] as (Stripe.SubscriptionItem & { current_period_end?: number }) | undefined;
    const periodEnd = item?.current_period_end ?? (s as unknown as { current_period_end?: number }).current_period_end ?? null;
    await tx`update subscriptions set subscription_id = ${s.id}, plan = ${best.plan}, period = ${best.period}, status = ${s.status},
      current_period_end = ${periodEnd ? new Date(periodEnd * 1000) : null}, trial_end = ${s.trial_end ? new Date(s.trial_end * 1000) : null},
      cancel_at_period_end = ${s.cancel_at_period_end}, trial_used = trial_used or ${trialUsed}, updated_at = now()
      where user_id = ${row.userId}`;
    const effective: OfferId = best.entitled ? best.plan! : FREE;
    await tx`update profiles set plan = ${effective} where user_id = ${row.userId}`;
    return effective;
  });
}

/** Synchronise à partir d'un abonnement (relu chez Stripe pour connaître son client). */
export async function syncSubscription(subscriptionId: string): Promise<OfferId | null> {
  const s = await stripe().subscriptions.retrieve(subscriptionId);
  return syncCustomer(typeof s.customer === 'string' ? s.customer : s.customer.id);
}

/** Événements d'abonnement du webhook. Rend true si l'événement a été traité ici. */
export async function handleBillingEvent(event: Stripe.Event) {
  if (event.type.startsWith('customer.subscription.')) {
    const c = (event.data.object as Stripe.Subscription).customer;
    await syncCustomer(typeof c === 'string' ? c : c.id);
    return true;
  }
  if (event.type === 'checkout.session.completed') {
    const cs = event.data.object as Stripe.Checkout.Session;
    if (cs.mode !== 'subscription') return false;
    const c = typeof cs.customer === 'string' ? cs.customer : cs.customer?.id;
    if (c) await syncCustomer(c);
    return true;
  }
  return false;
}

/** Page « Mon offre » : offre, abonnement et consommation au regard des limites. */
export async function billingOverview(userId: string) {
  return withUser(userId, async (tx) => {
    const [p] = await tx<{ plan: string }[]>`select plan from profiles where user_id = ${userId}`;
    const plan = (isOfferId(p?.plan) ? p.plan : FREE) as OfferId;
    const [sub] = await tx<{ plan: string | null; period: string | null; status: string | null; currentPeriodEnd: Date | null; trialEnd: Date | null;
      cancelAtPeriodEnd: boolean; trialUsed: boolean }[]>`
      select plan, period, status, current_period_end as "currentPeriodEnd", trial_end as "trialEnd", cancel_at_period_end as "cancelAtPeriodEnd",
             trial_used as "trialUsed" from subscriptions where user_id = ${userId}`;
    const [{ tracks }] = await tx<{ tracks: number }[]>`select count(*)::int as tracks from tracks where deleted_at is null`;
    const [{ contacts }] = await tx<{ contacts: number }[]>`select count(*)::int as contacts from contacts`;
    const limits = limitsOf(plan);
    return {
      plan, offerName: offerOf(plan).name,
      subscription: sub ? { ...sub, currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null, trialEnd: sub.trialEnd?.toISOString() ?? null } : null,
      usage: { tracks, storageBytes: await storageUsed(tx, userId), contacts, emailsThisMonth: await emailsThisMonth(tx, userId) },
      limits: { ...limits, storageBytes: limits.storageGb * GB },
    };
  });
}
