import { z } from 'zod';
import type Stripe from 'stripe';
import { asService, withPublic, withUser, type Tx } from './db';
import { Invalid, NotFound } from './library';
import { env } from './env';
import { hmac, safeEqualStr, sha256 } from './crypto';
import { enqueue } from './jobs';
import { stripe, verifyWebhook } from './stripe';
import { trackOffers } from './storefront';
import { EU_VAT, OUTSIDE_EU, withVat } from '@/config/vat';
import { commissionPct } from '@/config/offers';

/**
 * Lot 4.3 — ventes en mode test Stripe.
 * Montage « paiement puis virements séparés » : Sonikc encaisse (et reverse la TVA), puis vire à chaque
 * ayant droit sa part, 14 jours après le paiement. Toutes les écritures passent ici (flux de paiement,
 * comme les flux d'authentification : accès service) ; l'app ne fait que lire via la RLS.
 */

export const TRANSFER_DELAY_DAYS = 14;
const RESERVATION_MIN = 30;
const MAX_PENDING_PER_IP_HOUR = 10;

const uuid = z.string().uuid();
const email = z.string().trim().toLowerCase().email().max(254);
const country = z.string().refine((c) => c === OUTSIDE_EU || c in EU_VAT, 'Pays invalide.');

// ───────── Jetons : page de commande (acheteur sans compte) et téléchargements ─────────

const idToB64 = (id: string) => Buffer.from(id.replace(/-/g, ''), 'hex').toString('base64url');
const b64ToId = (s: string) => {
  const h = Buffer.from(s, 'base64url').toString('hex');
  return h.length === 32 ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : null;
};
export const orderToken = (orderId: string) => `${idToB64(orderId)}${hmac(`order:${orderId}`).slice(0, 22)}`;
export function parseOrderToken(token: string) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{44}$/.test(token)) return null;
  const id = b64ToId(token.slice(0, 22));
  return id && safeEqualStr(token.slice(22), hmac(`order:${id}`).slice(0, 22)) ? id : null;
}
export const orderUrl = (orderId: string) => `${env().APP_URL}/commande/${orderToken(orderId)}`;

/** Lien de téléchargement d'un fichier de commande : signé, valable 2 h. */
export function orderFilePath(orderId: string, kind: string, ttlS = 2 * 3600, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttlS;
  return `/api/orders/${orderId}/files/${kind}?exp=${exp}&sig=${hmac(`ofile:${orderId}:${kind}:${exp}`)}`;
}
export function verifyOrderFile(orderId: string, kind: string, exp: string | null, sig: string | null, now = Date.now()) {
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) * 1000 < now) return false;
  return safeEqualStr(sig, hmac(`ofile:${orderId}:${kind}:${exp}`));
}

// ───────── Parts ─────────

export type Share = { userId: string; isOwner: boolean; role: string; pct: number; amountCents: number };

/**
 * Reversement = prix HT − commission − frais Stripe, partagé au prorata des parts.
 * Chaque collaborateur reçoit sa part arrondie au centime inférieur ; le reste (centimes compris) va au propriétaire.
 */
export function computeShares(o: { netCents: number; commissionCents: number; feeCents: number; ownerId: string;
  splits: { userId: string; role: string; pct: number }[] }): Share[] {
  const base = Math.max(0, o.netCents - o.commissionCents - o.feeCents);
  const collabs = o.splits.map((s) => ({ userId: s.userId, isOwner: false, role: s.role, pct: s.pct, amountCents: Math.floor((base * s.pct) / 100) }));
  const ownerPct = Math.max(0, Math.round((100 - o.splits.reduce((a, s) => a + s.pct, 0)) * 100) / 100);
  const owner = { userId: o.ownerId, isOwner: true, role: 'Producteur', pct: ownerPct, amountCents: base - collabs.reduce((a, s) => a + s.amountCents, 0) };
  return [owner, ...collabs];
}

export const commissionCents = (netCents: number, pct: number) => Math.round((netCents * pct) / 100);

// ───────── Collaborateurs d'un morceau (propriétaire) ─────────

const splitsSchema = z.array(z.object({
  handle: z.string().trim().min(1).max(40),
  role: z.string().trim().max(40).default(''),
  pct: z.number().positive().max(100).multipleOf(0.01),
})).max(10);

export async function listSplits(userId: string, trackId: string) {
  uuid.parse(trackId);
  return withUser(userId, async (tx) => {
    const [t] = await tx`select 1 from tracks where id = ${trackId}`;
    if (!t) throw new NotFound();
    return tx<{ handle: string; displayName: string; role: string; pct: number; payoutsReady: boolean }[]>`
      select p.handle, p.display_name as "displayName", s.role, s.pct::float as pct,
             exists (select 1 from stripe_accounts a where a.user_id = s.collaborator_id and a.transfers_active) as "payoutsReady"
      from track_splits s join profiles p on p.user_id = s.collaborator_id
      where s.track_id = ${trackId} order by s.pct desc`;
  });
}

/** Remplace la liste des collaborateurs d'un morceau (par identifiant Sonikc). Total ≤ 100 % (contrôlé par la base). */
export async function setSplits(userId: string, trackId: string, raw: unknown) {
  uuid.parse(trackId);
  const list = splitsSchema.parse(raw);
  const total = list.reduce((a, s) => a + s.pct, 0);
  if (total > 100) throw new Invalid('Le total des parts dépasse 100 %.');
  await withUser(userId, async (tx) => {
    const [t] = await tx`select 1 from tracks where id = ${trackId}`;
    if (!t) throw new NotFound();
    await tx`delete from track_splits where track_id = ${trackId}`;
    const seen = new Set<string>();
    for (const s of list) {
      const [p] = await tx<{ userId: string }[]>`select user_id as "userId" from profiles where lower(handle) = ${s.handle.toLowerCase().replace(/^@/, '')}`;
      if (!p) throw new Invalid(`Identifiant inconnu : ${s.handle}`);
      if (p.userId === userId) throw new Invalid('Ta propre part est le reste : ne t’ajoute pas comme collaborateur.');
      if (seen.has(p.userId)) throw new Invalid(`${s.handle} figure deux fois.`);
      seen.add(p.userId);
      await tx`insert into track_splits (track_id, owner_id, collaborator_id, role, pct) values (${trackId}, ${userId}, ${p.userId}, ${s.role}, ${s.pct})`;
    }
  });
  return listSplits(userId, trackId);
}

// ───────── Début du paiement ─────────

const checkoutSchema = z.object({
  trackId: z.string().uuid(),
  templateId: z.string().uuid(),
  country,
  email,
});

export async function startCheckout(raw: unknown, ctx: { buyerUserId: string | null; ip: string; now?: Date }) {
  const input = checkoutSchema.parse(raw);
  const now = ctx.now ?? new Date();
  // Limite de paiements commencés : par adresse IP si l'hébergeur la fournit, sinon par email.
  const ipHash = sha256(`ip:${ctx.ip === 'unknown' ? `email:${input.email}` : ctx.ip}:${env().APP_SECRET}`);

  // 1. Ce qui est en vente, lu dans le catalogue public : impossible d'acheter un morceau privé ou une licence masquée.
  const found = await withPublic(async (tx) => {
    const [t] = await tx<{ title: string; ownerId: string; versionId: string; handle: string; sellerName: string }[]>`
      select t.title, t.owner_id as "ownerId", t.current_version_id as "versionId", p.handle, p.display_name as "sellerName"
      from tracks t join profiles p on p.user_id = t.owner_id where t.id = ${input.trackId}`;
    if (!t) return null;
    // La réservation de l'exclusive est vérifiée plus bas, de façon atomique (message clair à l'acheteur).
    const offer = (await trackOffers(tx, input.trackId, { ignoreReservation: true })).find((o) => o.id === input.templateId);
    return offer ? { ...t, offer } : null;
  });
  if (!found) throw new Invalid('Cette licence n’est plus disponible.');
  const { offer } = found;

  const price = withVat(offer.finalPriceCents, input.country);
  const plan = await asService(async (tx) => (await tx<{ plan: string }[]>`select plan from profiles where user_id = ${found.ownerId}`)[0]?.plan ?? 'free');
  const pct = commissionPct(plan);
  const licence = {
    name: offer.name, description: offer.description, formats: offer.formats, maxStreams: offer.maxStreams, maxCopies: offer.maxCopies,
    musicVideos: offer.musicVideos, radio: offer.radio, exclusive: offer.exclusive,
  };

  // 2. Commande en attente (et réservation de l'exclusive), dans une transaction.
  const orderId = await asService(async (tx) => {
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from orders
      where status = 'pending' and ip_hash = ${ipHash} and created_at > ${now} - interval '1 hour'`;
    if (n >= MAX_PENDING_PER_IP_HOUR) throw new Invalid('Trop de paiements commencés. Réessaie dans une heure.');
    const [o] = await tx<{ id: string }[]>`insert into orders (seller_id, track_id, version_id, template_id, track_title, seller_name, licence, exclusive,
        buyer_email, buyer_user_id, country, ip_hash, net_cents, vat_rate, vat_cents, gross_cents, plan, commission_pct, commission_cents, created_at)
      values (${found.ownerId}, ${input.trackId}, ${found.versionId}, ${offer.id}, ${found.title}, ${found.sellerName}, ${tx.json(licence)}, ${offer.exclusive},
        ${input.email}, ${ctx.buyerUserId}, ${input.country}, ${ipHash}, ${price.net}, ${price.rate}, ${price.vat}, ${price.gross}, ${plan}, ${pct},
        ${commissionCents(price.net, pct)}, ${now}) returning id`;
    if (offer.exclusive) {
      const r = await tx`update tracks set exclusive_reserved_until = ${now}::timestamptz + ${`${RESERVATION_MIN + 1} minutes`}::interval, exclusive_reserved_order = ${o.id}
        where id = ${input.trackId} and exclusive_sold_at is null and (exclusive_reserved_until is null or exclusive_reserved_until < ${now})`;
      if (!r.count) throw new Invalid('Quelqu’un est en train d’acheter cette exclusive. Réessaie dans une demi-heure.');
    }
    return o.id;
  });

  // 3. Session de paiement Stripe (pages de Stripe : aucune donnée de carte chez Sonikc).
  const countryName = EU_VAT[input.country]?.name ?? 'hors UE';
  try {
    const session = await stripe().checkout.sessions.create({
      mode: 'payment',
      locale: 'fr',
      customer_email: input.email,
      client_reference_id: orderId,
      expires_at: Math.floor(now.getTime() / 1000) + RESERVATION_MIN * 60,
      line_items: [
        { quantity: 1, price_data: { currency: 'eur', unit_amount: price.net, product_data: { name: `${found.title} — licence ${offer.name}`.slice(0, 250) } } },
        ...(price.vat ? [{ quantity: 1, price_data: { currency: 'eur', unit_amount: price.vat, product_data: { name: `TVA ${String(price.rate).replace('.', ',')} % (${countryName})` } } }] : []),
      ],
      metadata: { order_id: orderId },
      payment_intent_data: { metadata: { order_id: orderId }, transfer_group: orderId },
      success_url: `${orderUrl(orderId)}?paye=1`,
      cancel_url: `${env().APP_URL}/${found.handle}`,
    }, { idempotencyKey: `checkout-${orderId}` });
    await asService((tx) => tx`update orders set checkout_session_id = ${session.id} where id = ${orderId}`);
    return { orderId, url: session.url! };
  } catch (e) {
    await expireOrder(orderId);
    throw e;
  }
}

async function expireOrder(orderId: string) {
  await asService(async (tx) => {
    await tx`update orders set status = 'expired' where id = ${orderId} and status = 'pending'`;
    await tx`update tracks set exclusive_reserved_until = null, exclusive_reserved_order = null where exclusive_reserved_order = ${orderId}`;
  });
}

// ───────── Webhook ─────────

/**
 * Traite un webhook Stripe. Signature vérifiée (et âge ≤ 5 min) ; chaque événement n'est traité qu'une fois.
 * Rend le type traité, ou null pour un doublon ignoré.
 */
export async function handleWebhook(payload: string, signature: string | null) {
  const event = verifyWebhook(payload, signature);
  const fresh = await asService(async (tx) => (await tx`insert into stripe_events (id, type) values (${event.id}, ${event.type})
    on conflict (id) do nothing returning id`).length > 0);
  if (!fresh) {
    const [e] = await asService((tx) => tx<{ done: boolean }[]>`select processed_at is not null as done from stripe_events where id = ${event.id}`);
    if (e?.done) return null; // déjà traité
  }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const s = event.data.object as Stripe.Checkout.Session;
    if (s.payment_status === 'paid') await confirmPayment(s.id);
  } else if (event.type === 'checkout.session.expired') {
    const s = event.data.object as Stripe.Checkout.Session;
    const [o] = await asService((tx) => tx<{ id: string }[]>`select id from orders where checkout_session_id = ${s.id}`);
    if (o) await expireOrder(o.id);
  } else if (event.type === 'charge.refunded') {
    const c = event.data.object as Stripe.Charge;
    const pi = typeof c.payment_intent === 'string' ? c.payment_intent : c.payment_intent?.id;
    if (pi && c.amount_refunded >= c.amount) {
      const [o] = await asService((tx) => tx<{ id: string }[]>`select id from orders where payment_intent_id = ${pi}`);
      if (o) await afterRefund(o.id, 'Remboursé depuis Stripe');
    }
  }
  await asService((tx) => tx`update stripe_events set processed_at = now() where id = ${event.id}`);
  return event.type;
}

/** Paiement confirmé : on relit la session chez Stripe (montant, frais, pays de la carte), puis on fige tout. */
export async function confirmPayment(sessionId: string, now = new Date()) {
  const session = await stripe().checkout.sessions.retrieve(sessionId, { expand: ['payment_intent.latest_charge.balance_transaction'] });
  const orderId = session.metadata?.order_id;
  if (!orderId || session.payment_status !== 'paid') return;
  const pi = session.payment_intent as Stripe.PaymentIntent | null;
  const charge = (pi?.latest_charge ?? null) as Stripe.Charge | null;
  const bt = (charge?.balance_transaction ?? null) as Stripe.BalanceTransaction | null;
  const fee = bt?.fee ?? 0;
  const cardCountry = charge?.payment_method_details?.card?.country ?? null;

  const result = await asService(async (tx) => {
    const [o] = await tx<{ id: string; status: string; sellerId: string; trackId: string | null; exclusive: boolean; netCents: number;
      grossCents: number; commissionCents: number }[]>`
      select id, status, seller_id as "sellerId", track_id as "trackId", exclusive, net_cents as "netCents", gross_cents as "grossCents",
             commission_cents as "commissionCents" from orders where id = ${orderId} for update`;
    if (!o) throw new Error(`commande inconnue ${orderId}`);
    if (o.status === 'paid' || o.status === 'refunded') return { duplicate: true as const };
    if (session.amount_total !== o.grossCents || session.currency !== 'eur') throw new Error(`montant inattendu pour ${orderId}`);

    // Exclusive déjà vendue à quelqu'un d'autre (cas limite) : la commande est payée puis remboursée aussitôt.
    let refund = false;
    if (o.exclusive && o.trackId) {
      const [t] = await tx<{ soldOrder: string | null }[]>`select exclusive_sold_order as "soldOrder" from tracks where id = ${o.trackId} for update`;
      if (t?.soldOrder && t.soldOrder !== o.id) refund = true;
      else await tx`update tracks set exclusive_sold_at = ${now}, exclusive_sold_order = ${o.id},
        exclusive_reserved_until = null, exclusive_reserved_order = null where id = ${o.trackId}`;
    }
    const year = now.getUTCFullYear();
    const [{ no }] = await tx<{ no: number }[]>`insert into invoice_counters (series, last_no) values (${`F${year}`}, 1)
      on conflict (series) do update set last_no = invoice_counters.last_no + 1 returning last_no as no`;
    const due = new Date(now.getTime() + TRANSFER_DELAY_DAYS * 86400_000);
    await tx`update orders set status = 'paid', paid_at = ${now}, invoice_no = ${`F${year}-${String(no).padStart(6, '0')}`},
      payment_intent_id = ${pi?.id ?? null}, charge_id = ${charge?.id ?? null}, stripe_fee_cents = ${fee}, card_country = ${cardCountry},
      transfers_due_at = ${due} where id = ${o.id}`;
    const splits = o.trackId ? await tx<{ userId: string; role: string; pct: number }[]>`
      select collaborator_id as "userId", role, pct::float as pct from track_splits where track_id = ${o.trackId} order by pct desc, collaborator_id` : [];
    const shares = computeShares({ netCents: o.netCents, commissionCents: o.commissionCents, feeCents: fee, ownerId: o.sellerId, splits });
    for (const s of shares) {
      await tx`insert into order_shares (order_id, user_id, is_owner, role, pct, amount_cents)
        values (${o.id}, ${s.userId}, ${s.isOwner}, ${s.role}, ${s.pct}, ${s.amountCents})`;
    }
    if (!refund) {
      await enqueue(tx, 'order_deliver', { orderId: o.id });
      await enqueue(tx, 'order_transfers', { orderId: o.id }, due);
    }
    return { duplicate: false as const, refund, orderId: o.id };
  });
  if (!result.duplicate && result.refund) await refundOrder(result.orderId, 'Exclusive déjà vendue : remboursement automatique', now);
}

// ───────── Remboursement ─────────

/** Le vendeur rembourse une de ses ventes. */
export async function refundBySeller(userId: string, orderId: string) {
  uuid.parse(orderId);
  const [o] = await withUser(userId, (tx) => tx<{ status: string }[]>`select status from orders where id = ${orderId} and seller_id = ${userId}`);
  if (!o) throw new NotFound();
  if (o.status !== 'paid') throw new Invalid('Cette vente est déjà remboursée.');
  await refundOrder(orderId, 'Remboursé par le producteur');
}

/** Rembourse chez Stripe (une seule fois grâce à la clé d'idempotence), puis annule ou reprend les virements. */
export async function refundOrder(orderId: string, reason: string, now = new Date()) {
  const [o] = await asService((tx) => tx<{ pi: string | null; status: string }[]>`select payment_intent_id as pi, status from orders where id = ${orderId}`);
  if (!o || o.status !== 'paid' || !o.pi) return;
  await stripe().refunds.create({ payment_intent: o.pi, metadata: { order_id: orderId } }, { idempotencyKey: `refund-${orderId}` });
  await afterRefund(orderId, reason, now);
}

/** Effets d'un remboursement (qu'il vienne de Sonikc ou du tableau de bord Stripe). Idempotent. */
export async function afterRefund(orderId: string, reason: string, now = new Date()) {
  const toReverse = await asService(async (tx) => {
    const [o] = await tx<{ status: string; trackId: string | null }[]>`select status, track_id as "trackId" from orders where id = ${orderId} for update`;
    if (!o || o.status !== 'paid') return null;
    const year = now.getUTCFullYear();
    const [{ no }] = await tx<{ no: number }[]>`insert into invoice_counters (series, last_no) values (${`A${year}`}, 1)
      on conflict (series) do update set last_no = invoice_counters.last_no + 1 returning last_no as no`;
    await tx`update orders set status = 'refunded', refunded_at = ${now}, refund_reason = ${reason},
      credit_note_no = ${`A${year}-${String(no).padStart(6, '0')}`} where id = ${orderId}`;
    // Exclusive remboursée : le morceau peut de nouveau être vendu.
    if (o.trackId) await tx`update tracks set exclusive_sold_at = null, exclusive_sold_order = null where id = ${o.trackId} and exclusive_sold_order = ${orderId}`;
    // Avant le virement : la part prévue est annulée. Après : elle est reprise (ci-dessous).
    await tx`update order_shares set status = 'canceled' where order_id = ${orderId} and status in ('scheduled', 'held')`;
    await enqueue(tx, 'order_credit_note', { orderId });
    return tx<{ userId: string; transferId: string }[]>`select user_id as "userId", transfer_id as "transferId" from order_shares
      where order_id = ${orderId} and status = 'transferred'`;
  });
  for (const s of toReverse ?? []) {
    await stripe().transfers.createReversal(s.transferId, { metadata: { order_id: orderId } }, { idempotencyKey: `reversal-${orderId}-${s.userId}` });
    await asService((tx) => tx`update order_shares set status = 'reversed' where order_id = ${orderId} and user_id = ${s.userId}`);
  }
}

// ───────── Virements (14 jours après le paiement) ─────────

/**
 * Vire chaque part due. Sans compte de reversement actif, la part reste « en attente » (rien n'est perdu) et
 * la tâche repasse le lendemain ; activer son compte relance aussitôt les parts en attente.
 */
export async function runTransfers(orderId: string, now = new Date()) {
  const [o] = await asService((tx) => tx<{ status: string; chargeId: string | null; due: Date | null }[]>`
    select status, charge_id as "chargeId", transfers_due_at as due from orders where id = ${orderId}`);
  if (!o || o.status !== 'paid' || !o.due || o.due.getTime() > now.getTime()) return { transferred: 0, held: 0 };
  const shares = await asService((tx) => tx<{ userId: string; amountCents: number; accountId: string | null; active: boolean | null }[]>`
    select s.user_id as "userId", s.amount_cents as "amountCents", a.account_id as "accountId", a.transfers_active as active
    from order_shares s left join stripe_accounts a on a.user_id = s.user_id
    where s.order_id = ${orderId} and s.status in ('scheduled', 'held')`);
  let transferred = 0, held = 0;
  for (const s of shares) {
    if (s.amountCents === 0) { await asService((tx) => tx`update order_shares set status = 'canceled' where order_id = ${orderId} and user_id = ${s.userId}`); continue; }
    let active = Boolean(s.active);
    if (s.accountId && !active) active = (await refreshAccountById(s.userId, s.accountId)).transfersActive;
    if (!s.accountId || !active) {
      held++;
      await asService((tx) => tx`update order_shares set status = 'held' where order_id = ${orderId} and user_id = ${s.userId} and status = 'scheduled'`);
      continue;
    }
    const tr = await stripe().transfers.create({
      amount: s.amountCents, currency: 'eur', destination: s.accountId!, transfer_group: orderId,
      ...(o.chargeId ? { source_transaction: o.chargeId } : {}), metadata: { order_id: orderId, user_id: s.userId },
    }, { idempotencyKey: `transfer-${orderId}-${s.userId}` });
    // Une commande remboursée entre-temps : la part qui vient d'être virée est aussitôt reprise.
    const stillPaid = await asService(async (tx) => {
      const [x] = await tx<{ status: string }[]>`select status from orders where id = ${orderId} for update`;
      await tx`update order_shares set status = 'transferred', transfer_id = ${tr.id} where order_id = ${orderId} and user_id = ${s.userId}`;
      return x.status === 'paid';
    });
    if (!stillPaid) {
      await stripe().transfers.createReversal(tr.id, { metadata: { order_id: orderId } }, { idempotencyKey: `reversal-${orderId}-${s.userId}` });
      await asService((tx) => tx`update order_shares set status = 'reversed' where order_id = ${orderId} and user_id = ${s.userId}`);
    } else transferred++;
  }
  if (held) await asService((tx) => enqueue(tx, 'order_transfers', { orderId }, new Date(now.getTime() + 86400_000)));
  return { transferred, held };
}

// ───────── Comptes de reversement (Stripe Connect Express) ─────────

export async function payoutAccount(userId: string) {
  const [a] = await withUser(userId, (tx) => tx<{ accountId: string; transfersActive: boolean; detailsSubmitted: boolean }[]>`
    select account_id as "accountId", transfers_active as "transfersActive", details_submitted as "detailsSubmitted" from stripe_accounts where user_id = ${userId}`);
  return a ?? null;
}

/** Crée (une seule fois) le compte Express du producteur et rend l'adresse du formulaire d'activation chez Stripe. */
export async function startOnboarding(userId: string) {
  let [a] = await asService((tx) => tx<{ accountId: string }[]>`select account_id as "accountId" from stripe_accounts where user_id = ${userId}`);
  if (!a) {
    const acct = await stripe().accounts.create({
      type: 'express', country: env().STRIPE_CONNECT_COUNTRY,
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      metadata: { user_id: userId },
    }, { idempotencyKey: `account-${userId}` });
    await asService((tx) => tx`insert into stripe_accounts (user_id, account_id, country) values (${userId}, ${acct.id}, ${env().STRIPE_CONNECT_COUNTRY})
      on conflict (user_id) do nothing`);
    [a] = await asService((tx) => tx<{ accountId: string }[]>`select account_id as "accountId" from stripe_accounts where user_id = ${userId}`);
  }
  const link = await stripe().accountLinks.create({
    account: a.accountId, type: 'account_onboarding',
    refresh_url: `${env().APP_URL}/app/ventes?connect=relancer`, return_url: `${env().APP_URL}/app/ventes?connect=retour`,
  });
  return { url: link.url };
}

export async function refreshAccount(userId: string) {
  const [a] = await asService((tx) => tx<{ accountId: string }[]>`select account_id as "accountId" from stripe_accounts where user_id = ${userId}`);
  return a ? refreshAccountById(userId, a.accountId) : null;
}

async function refreshAccountById(userId: string, accountId: string) {
  const acct = await stripe().accounts.retrieve(accountId);
  const transfersActive = acct.capabilities?.transfers === 'active' && Boolean(acct.payouts_enabled);
  const wasActive = await asService(async (tx) => {
    const [prev] = await tx<{ active: boolean }[]>`select transfers_active as active from stripe_accounts where user_id = ${userId} for update`;
    await tx`update stripe_accounts set transfers_active = ${transfersActive}, details_submitted = ${Boolean(acct.details_submitted)}, updated_at = now()
      where user_id = ${userId}`;
    // Compte tout juste activé : les parts en attente partent maintenant.
    if (transfersActive && !prev?.active) {
      const held = await tx<{ orderId: string }[]>`select distinct order_id as "orderId" from order_shares where user_id = ${userId} and status = 'held'`;
      for (const h of held) await enqueue(tx, 'order_transfers', { orderId: h.orderId });
    }
    return Boolean(prev?.active);
  });
  return { transfersActive, detailsSubmitted: Boolean(acct.details_submitted), justActivated: transfersActive && !wasActive };
}

// ───────── Lecture : ventes, parts, achats ─────────

export type SaleRow = {
  id: string; createdAt: Date; paidAt: Date; trackTitle: string; licenceName: string; buyerEmail: string; country: string;
  grossCents: number; netCents: number; vatCents: number; commissionCents: number; feeCents: number; status: string;
  invoiceNo: string; myShareCents: number; myShareStatus: string; isSeller: boolean; transfersDueAt: Date;
  shares: { handle: string; pct: number; amountCents: number; status: string; isOwner: boolean }[];
};

export async function listSales(userId: string): Promise<SaleRow[]> {
  return withUser(userId, async (tx) => {
    const rows = await tx<Omit<SaleRow, 'shares'>[]>`
      select o.id, o.created_at as "createdAt", o.paid_at as "paidAt", o.track_title as "trackTitle", o.licence->>'name' as "licenceName",
             o.buyer_email as "buyerEmail", o.country, o.gross_cents as "grossCents", o.net_cents as "netCents", o.vat_cents as "vatCents",
             o.commission_cents as "commissionCents", coalesce(o.stripe_fee_cents, 0) as "feeCents", o.status, o.invoice_no as "invoiceNo",
             s.amount_cents as "myShareCents", s.status as "myShareStatus", o.seller_id = ${userId} as "isSeller", o.transfers_due_at as "transfersDueAt"
      from orders o join order_shares s on s.order_id = o.id and s.user_id = ${userId}
      order by o.paid_at desc limit 500`;
    const ids = rows.map((r) => r.id);
    const shares = ids.length ? await tx<{ orderId: string; handle: string; pct: number; amountCents: number; status: string; isOwner: boolean }[]>`
      select s.order_id as "orderId", p.handle, s.pct::float as pct, s.amount_cents as "amountCents", s.status, s.is_owner as "isOwner"
      from order_shares s join profiles p on p.user_id = s.user_id where s.order_id = any(${ids}::uuid[]) order by s.is_owner desc, s.pct desc` : [];
    return rows.map((r) => ({ ...r, shares: r.isSeller ? shares.filter((s) => s.orderId === r.id).map(({ orderId: _o, ...s }) => s) : [] }));
  });
}

export async function listPurchases(userId: string) {
  return withUser(userId, (tx) => tx<{ id: string; paidAt: Date; trackTitle: string; sellerName: string; licenceName: string; grossCents: number; status: string }[]>`
    select id, paid_at as "paidAt", track_title as "trackTitle", seller_name as "sellerName", licence->>'name' as "licenceName",
           gross_cents as "grossCents", status
    from orders where (buyer_user_id = ${userId} or lower(buyer_email) = app.current_email()) order by paid_at desc limit 500`);
}

/** Page de commande : par jeton signé (acheteur sans compte), ou par un utilisateur qui y a droit. */
export async function orderView(orderId: string) {
  return asService(async (tx) => {
    const [o] = await tx<{ id: string; status: string; trackTitle: string; sellerName: string; licence: Record<string, unknown>; buyerEmail: string;
      country: string; netCents: number; vatRate: number; vatCents: number; grossCents: number; invoiceNo: string | null; creditNoteNo: string | null;
      paidAt: Date | null; refundedAt: Date | null; deliveredAt: Date | null }[]>`
      select id, status, track_title as "trackTitle", seller_name as "sellerName", licence, buyer_email as "buyerEmail", country,
             net_cents as "netCents", vat_rate::float as "vatRate", vat_cents as "vatCents", gross_cents as "grossCents", invoice_no as "invoiceNo",
             credit_note_no as "creditNoteNo", paid_at as "paidAt", refunded_at as "refundedAt", delivered_at as "deliveredAt"
      from orders where id = ${orderId}`;
    if (!o) return null;
    const files = await tx<{ kind: string; filename: string; sha256: string; sizeBytes: number }[]>`
      select kind, filename, sha256, size_bytes::int as "sizeBytes" from order_files where order_id = ${orderId} order by kind`;
    const [cert] = await tx<{ issuedAt: Date; files: { format: string; sha256: string }[] }[]>`
      select issued_at as "issuedAt", files from licence_certificates where order_id = ${orderId}`;
    return { ...o, files, certificate: cert ?? null };
  });
}

/** Fichier d'une commande. Les fichiers audio et la licence ne sont plus servis après remboursement ; facture et avoir restent. */
export async function orderFile(orderId: string, kind: string) {
  const [f] = await asService((tx) => tx<{ key: string; filename: string; status: string }[]>`
    select f.storage_key as key, f.filename, o.status from order_files f join orders o on o.id = f.order_id
    where f.order_id = ${orderId} and f.kind = ${kind}`);
  if (!f) return null;
  if (f.status !== 'paid' && !['invoice', 'credit_note'].includes(kind)) return null;
  return f;
}

export type CommerceTx = Tx;
