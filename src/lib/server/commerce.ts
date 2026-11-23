import { z } from 'zod';
import type Stripe from 'stripe';
import { asPayments, withPublic, withUser, type Tx } from './db';
import { Invalid, NotFound } from './library';
import { env } from './env';
import { hmac, safeEqualStr, sha256 } from './crypto';
import { enqueue } from './jobs';
import { stripe, verifyWebhook } from './stripe';
import { sendMail } from './mail';
import { trackOffers } from './storefront';
import { EU_VAT, OUTSIDE_EU, withVat } from '@/config/vat';
import { commissionPct } from '@/config/offers';
import { assertInvoiceReady } from '@/config/company';

/**
 * Lot 4.3 — ventes en mode test Stripe.
 * Montage « paiement puis virements séparés » : Sonikc encaisse (et reverse la TVA), puis vire à chaque
 * ayant droit sa part, 14 jours après le paiement. Toutes les écritures passent ici (flux de paiement,
 * comme les flux d'authentification : accès service) ; l'app ne fait que lire via la RLS.
 */

export const TRANSFER_DELAY_DAYS = 14;
const SESSION_MIN = 32; // Stripe exige au moins 30 min entre la création de la session et son expiration
const RESERVATION_MIN = SESSION_MIN + 2;
const MAX_EXCLUSIVE_TRIES_PER_DAY = 2; // par personne (IP ou email) et par morceau : pas de blocage d'une exclusive à répétition
const MAX_PENDING_PER_IP_HOUR = 10;

const uuid = z.string().uuid();
const email = z.string().trim().toLowerCase().email().max(254);
const country = z.string().refine((c) => c === OUTSIDE_EU || Object.hasOwn(EU_VAT, c), 'Pays invalide.');

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
  // Calcul en entiers (centièmes de pour cent) : pas d'erreur d'arrondi flottant.
  const collabs = o.splits.map((s) => ({ userId: s.userId, isOwner: false, role: s.role, pct: s.pct, amountCents: Math.floor((base * Math.round(s.pct * 100)) / 10_000) }));
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

export type SplitRow = { handle: string; displayName: string; role: string; pct: number; status: 'pending' | 'accepted' | 'declined' | 'withdrawn';
  acceptedPct: number | null; payoutsReady: boolean };

export async function listSplits(userId: string, trackId: string): Promise<SplitRow[]> {
  uuid.parse(trackId);
  return withUser(userId, async (tx) => {
    const [t] = await tx`select 1 from tracks where id = ${trackId}`;
    if (!t) throw new NotFound();
    return tx<SplitRow[]>`
      select p.handle, p.display_name as "displayName", s.role, s.pct::float as pct, s.status, s.accepted_pct::float as "acceptedPct",
             exists (select 1 from stripe_accounts a where a.user_id = s.collaborator_id and a.transfers_active) as "payoutsReady"
      from track_splits s join profiles p on p.user_id = s.collaborator_id
      where s.track_id = ${trackId} order by s.pct desc`;
  });
}

const INVITES_PER_OWNER_PER_DAY = 30;
const oneLine = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Met à jour la liste des collaborateurs d'un morceau (par identifiant Sonikc). Une ligne inchangée garde la réponse
 * du collaborateur ; une nouvelle ligne, ou un pourcentage ou rôle changé, lui redemande son accord (la base l'impose).
 * Les conditions déjà acceptées restent en vigueur d'ici là. Invitation par email : au plus une par personne et par
 * producteur toutes les 24 h, et 30 par producteur et par jour.
 */
export async function setSplits(userId: string, trackId: string, raw: unknown) {
  uuid.parse(trackId);
  const list = splitsSchema.parse(raw);
  // Total ≤ 100 % vérifié par la base à la fin de la transaction (parts refusées ou retirées exclues, parts en vigueur comprises).
  const invite = await withUser(userId, async (tx) => {
    const [t] = await tx<{ title: string }[]>`select title from tracks where id = ${trackId}`;
    if (!t) throw new NotFound();
    const current = await tx<{ collaboratorId: string; role: string; pct: number }[]>`
      select collaborator_id as "collaboratorId", role, pct::float as pct from track_splits where track_id = ${trackId}`;
    const wanted = new Map<string, { role: string; pct: number }>();
    for (const s of list) {
      const [p] = await tx<{ userId: string }[]>`select user_id as "userId" from profiles where lower(handle) = ${s.handle.toLowerCase().replace(/^@/, '')}`;
      if (!p) throw new Invalid(`Identifiant inconnu : ${s.handle}`);
      if (p.userId === userId) throw new Invalid('Ta propre part est le reste : ne t’ajoute pas comme collaborateur.');
      if (wanted.has(p.userId)) throw new Invalid(`${s.handle} figure deux fois.`);
      wanted.set(p.userId, { role: s.role, pct: s.pct });
    }
    const invited: string[] = [];
    for (const c of current) {
      const w = wanted.get(c.collaboratorId);
      if (!w) await tx`delete from track_splits where track_id = ${trackId} and collaborator_id = ${c.collaboratorId}`;
      else if (w.role !== c.role || w.pct !== c.pct) {
        await tx`update track_splits set role = ${w.role}, pct = ${w.pct} where track_id = ${trackId} and collaborator_id = ${c.collaboratorId}`;
        invited.push(c.collaboratorId);
      }
    }
    for (const [collaboratorId, w] of wanted) {
      if (current.some((c) => c.collaboratorId === collaboratorId)) continue;
      await tx`insert into track_splits (track_id, owner_id, collaborator_id, role, pct) values (${trackId}, ${userId}, ${collaboratorId}, ${w.role}, ${w.pct})`;
      invited.push(collaboratorId);
    }
    return { title: t.title, invited };
  }).catch((e) => {
    if (String((e as Error).message).includes('splits exceed')) throw new Invalid('Le total des parts dépasse 100 %.');
    throw e;
  });
  if (invite.invited.length) await sendSplitInvites(userId, trackId, invite.title, invite.invited);
  return listSplits(userId, trackId);
}

async function sendSplitInvites(ownerId: string, trackId: string, title: string, collaboratorIds: string[]) {
  const toSend = await asPayments(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`split-invites:${ownerId}`}))`;
    const [{ today }] = await tx<{ today: number }[]>`select count(*)::int as today from split_invite_log
      where owner_id = ${ownerId} and sent_at > now() - interval '1 day'`;
    const recent = await tx<{ id: string }[]>`select distinct collaborator_id as id from split_invite_log
      where owner_id = ${ownerId} and collaborator_id = any(${collaboratorIds}::uuid[]) and sent_at > now() - interval '1 day'`;
    const ids = collaboratorIds.filter((id) => !recent.some((r) => r.id === id)).slice(0, Math.max(0, INVITES_PER_OWNER_PER_DAY - today));
    for (const id of ids) await tx`insert into split_invite_log (owner_id, collaborator_id) values (${ownerId}, ${id})`;
    return ids.length ? tx<{ email: string; pct: number; owner: string }[]>`
      select u.email, s.pct::float as pct, p.display_name as owner from track_splits s
      join users u on u.id = s.collaborator_id join profiles p on p.user_id = s.owner_id
      where s.track_id = ${trackId} and s.collaborator_id = any(${ids}::uuid[]) and s.status = 'pending'` : [];
  });
  const name = oneLine(title, 80), owner = (o: string) => oneLine(o, 60);
  for (const r of toSend) {
    const pct = String(r.pct).replace('.', ',');
    await sendMail({
      to: r.email, tag: 'split_invite',
      subject: oneLine(`Invitation de collaboration sur Sonikc : ${pct} % des ventes de « ${name} »`, 150),
      text: `${owner(r.owner)} (producteur sur Sonikc) te propose ${pct} % de ce qui revient aux ayants droit sur chaque vente du morceau « ${name} ».\n\nRéponds dans ton espace Sonikc, rubrique « Ventes » :\n${env().APP_URL}/app/ventes\n\nTa part ne s’applique qu’aux ventes faites après ton accord. Si tu ne connais pas ce producteur, refuse simplement.\n\n— Sonikc`,
    }).catch((e) => console.error('invitation collaborateur', (e as Error).message));
  }
}

export type SplitInvite = { trackId: string; trackTitle: string; ownerName: string; ownerHandle: string; role: string; pct: number;
  status: 'pending' | 'accepted' | 'declined' | 'withdrawn'; acceptedPct: number | null; invitedAt: string };

/** Les collaborations proposées à cet utilisateur ou en vigueur (lues côté serveur, limitées à ses propres lignes). */
export async function listSplitInvites(userId: string): Promise<SplitInvite[]> {
  const rows = await asPayments((tx) => tx<(Omit<SplitInvite, 'invitedAt'> & { invitedAt: Date })[]>`
    select s.track_id as "trackId", t.title as "trackTitle", p.display_name as "ownerName", p.handle as "ownerHandle", s.role,
           s.pct::float as pct, s.status, s.accepted_pct::float as "acceptedPct", s.invited_at as "invitedAt"
    from track_splits s join tracks t on t.id = s.track_id join profiles p on p.user_id = s.owner_id
    where s.collaborator_id = ${userId} and t.deleted_at is null and (s.status in ('pending', 'accepted') or s.accepted_pct is not null)
    order by s.status = 'pending' desc, s.invited_at desc limit 200`);
  return rows.map((r) => ({ ...r, invitedAt: r.invitedAt.toISOString() }));
}

const answerSchema = z.object({
  accept: z.boolean(),
  // Les conditions affichées au collaborateur : s'il y a eu un changement entre-temps, la réponse est refusée.
  pct: z.number(), role: z.string(), invitedAt: z.string().datetime(),
});

/** Le collaborateur accepte ou refuse la proposition qu'il a vue (la base refuse toute autre modification). */
export async function respondSplit(userId: string, trackId: string, raw: unknown) {
  uuid.parse(trackId);
  const a = answerSchema.parse(raw);
  const r = await withUser(userId, (tx) => tx`update track_splits set status = ${a.accept ? 'accepted' : 'declined'}
    where track_id = ${trackId} and collaborator_id = ${userId} and status = 'pending'
      and pct = ${a.pct} and role = ${a.role} and date_trunc('milliseconds', invited_at) = ${a.invitedAt}::timestamptz`);
  if (!r.count) throw new Invalid('La proposition a changé ou n’existe plus. Recharge la page.');
}

/** Le collaborateur se retire : sa part cesse de s'appliquer aux ventes suivantes. */
export async function withdrawSplit(userId: string, trackId: string) {
  uuid.parse(trackId);
  const r = await withUser(userId, (tx) => tx`update track_splits set status = 'withdrawn'
    where track_id = ${trackId} and collaborator_id = ${userId} and status <> 'withdrawn'`);
  if (!r.count) throw new NotFound();
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
  assertInvoiceReady();
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
  const plan = await asPayments(async (tx) => (await tx<{ plan: string }[]>`select plan from profiles where user_id = ${found.ownerId}`)[0]?.plan ?? 'free');
  const pct = commissionPct(plan);
  const licence = {
    name: offer.name, description: offer.description, formats: offer.formats, maxStreams: offer.maxStreams, maxCopies: offer.maxCopies,
    musicVideos: offer.musicVideos, radio: offer.radio, exclusive: offer.exclusive,
  };

  // 2. Commande en attente (et réservation de l'exclusive), dans une transaction.
  const orderId = await asPayments(async (tx) => {
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from orders
      where status = 'pending' and ip_hash = ${ipHash} and created_at > ${now} - interval '1 hour'`;
    if (n >= MAX_PENDING_PER_IP_HOUR) throw new Invalid('Trop de paiements commencés. Réessaie dans une heure.');
    if (offer.exclusive) {
      const [{ x }] = await tx<{ x: number }[]>`select count(*)::int as x from orders where track_id = ${input.trackId} and exclusive
        and ip_hash = ${ipHash} and status in ('pending', 'expired') and created_at > ${now} - interval '1 day'`;
      if (x >= MAX_EXCLUSIVE_TRIES_PER_DAY) throw new Invalid('Tu as déjà commencé deux fois l’achat de cette exclusive aujourd’hui. Réessaie demain.');
    }
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
      expires_at: Math.floor(Date.now() / 1000) + SESSION_MIN * 60,
      allowed_payment_method_types: ['card'], // paiement immédiat : pas de virement qui arrive des jours après la réservation
      line_items: [
        { quantity: 1, price_data: { currency: 'eur', unit_amount: price.net, product_data: { name: `${found.title} — licence ${offer.name}`.slice(0, 250) } } },
        ...(price.vat ? [{ quantity: 1, price_data: { currency: 'eur', unit_amount: price.vat, product_data: { name: `TVA ${String(price.rate).replace('.', ',')} % (${countryName})` } } }] : []),
      ],
      metadata: { order_id: orderId },
      payment_intent_data: { metadata: { order_id: orderId }, transfer_group: orderId },
      success_url: `${orderUrl(orderId)}?paye=1`,
      cancel_url: `${env().APP_URL}/${found.handle}`,
    }, { idempotencyKey: `checkout-${orderId}` });
    await asPayments((tx) => tx`update orders set checkout_session_id = ${session.id} where id = ${orderId}`);
    return { orderId, url: session.url! };
  } catch (e) {
    await expireOrder(orderId);
    throw e;
  }
}

async function expireOrder(orderId: string) {
  await asPayments(async (tx) => {
    await tx`update orders set status = 'expired' where id = ${orderId} and status = 'pending'`;
    await tx`update tracks set exclusive_reserved_until = null, exclusive_reserved_order = null where exclusive_reserved_order = ${orderId}`;
  });
}

// ───────── Webhook ─────────

export class SignatureError extends Error {}

/**
 * Traite un webhook Stripe. Signature vérifiée (et âge ≤ 5 min) ; chaque événement n'est traité qu'une fois.
 * Rend le type traité, ou null pour un doublon ignoré.
 */
export async function handleWebhook(payload: string, signature: string | null) {
  let event: Stripe.Event;
  try { event = verifyWebhook(payload, signature); } catch (e) { throw new SignatureError((e as Error).message); }
  await asPayments((tx) => tx`insert into stripe_events (id, type) values (${event.id}, ${event.type}) on conflict (id) do nothing`);
  const [done] = await asPayments((tx) => tx<{ done: boolean }[]>`select processed_at is not null as done from stripe_events where id = ${event.id}`);
  if (done?.done) return null; // déjà traité
  const orderOfCharge = async (c: Stripe.Charge | Stripe.Dispute) => {
    const pi = typeof c.payment_intent === 'string' ? c.payment_intent : c.payment_intent?.id;
    if (!pi) return null;
    const [o] = await asPayments((tx) => tx<{ id: string }[]>`select id from orders where payment_intent_id = ${pi}`);
    return o?.id ?? null;
  };
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const s = event.data.object as Stripe.Checkout.Session;
    if (s.payment_status === 'paid') await confirmPayment(s.id);
  } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
    const s = event.data.object as Stripe.Checkout.Session;
    const [o] = await asPayments((tx) => tx<{ id: string }[]>`select id from orders where checkout_session_id = ${s.id}`);
    if (o) await expireOrder(o.id);
  } else if (event.type === 'charge.refunded') {
    const c = event.data.object as Stripe.Charge;
    const id = c.amount_refunded >= c.amount ? await orderOfCharge(c) : null;
    // Commande encore « en attente » (confirmation pas encore traitée) : la confirmation verra le remboursement chez Stripe.
    if (id) await afterRefund(id, 'Remboursé depuis Stripe');
  } else if (event.type === 'charge.dispute.created') {
    const id = await orderOfCharge(event.data.object as Stripe.Dispute);
    if (id) await asPayments(async (tx) => {
      await tx`update orders set disputed_at = now() where id = ${id}`;
      await tx`update order_shares set status = 'disputed' where order_id = ${id} and status in ('scheduled', 'held')`;
    });
  } else if (event.type === 'charge.dispute.closed') {
    const d = event.data.object as Stripe.Dispute;
    const id = await orderOfCharge(d);
    if (id && d.status === 'won') await asPayments(async (tx) => {
      await tx`update orders set disputed_at = null where id = ${id}`;
      await tx`update order_shares set status = 'scheduled', retry_at = null where order_id = ${id} and status = 'disputed'`;
    });
    else if (id && d.status === 'lost') await afterRefund(id, 'Litige perdu : paiement repris par la banque');
  }
  await asPayments((tx) => tx`update stripe_events set processed_at = now() where id = ${event.id}`);
  return event.type;
}

/** Paiement confirmé : on relit la session chez Stripe (montant, frais, pays de la carte, remboursement éventuel), puis on fige tout. */
export async function confirmPayment(sessionId: string, now = new Date()) {
  const session = await stripe().checkout.sessions.retrieve(sessionId, { expand: ['payment_intent.latest_charge.balance_transaction'] });
  const orderId = session.metadata?.order_id;
  if (!orderId || session.payment_status !== 'paid') return;
  const pi = session.payment_intent as Stripe.PaymentIntent | null;
  const charge = (pi?.latest_charge ?? null) as Stripe.Charge | null;
  let bt = (charge?.balance_transaction ?? null) as Stripe.BalanceTransaction | null;
  // Juste après le paiement, Stripe n'a pas toujours calculé ses frais : on relit la charge quelques secondes.
  // Sans frais connus, on ne fige rien (erreur → Stripe renverra l'événement) : jamais de part calculée avec des frais faux.
  for (let i = 0; charge && !bt && i < 5; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const c = await stripe().charges.retrieve(charge.id, { expand: ['balance_transaction'] });
    bt = (c.balance_transaction ?? null) as Stripe.BalanceTransaction | null;
  }
  if (charge && !bt) throw new Error(`frais Stripe pas encore disponibles pour ${sessionId}`);
  const fee = bt?.fee ?? 0;
  const cardCountry = charge?.payment_method_details?.card?.country ?? null;
  const alreadyRefunded = Boolean(charge && charge.amount_refunded >= charge.amount);

  const result = await asPayments(async (tx) => {
    const [o] = await tx<{ id: string; status: string; sellerId: string; trackId: string | null; exclusive: boolean; netCents: number;
      grossCents: number; commissionCents: number; country: string }[]>`
      select id, status, seller_id as "sellerId", track_id as "trackId", exclusive, net_cents as "netCents", gross_cents as "grossCents",
             commission_cents as "commissionCents", country from orders where id = ${orderId} for update`;
    if (!o) throw new Error(`commande inconnue ${orderId}`);
    if (o.status === 'paid' || o.status === 'refunded') return { duplicate: true as const };
    if (session.amount_total !== o.grossCents || session.currency !== 'eur') throw new Error(`montant inattendu pour ${orderId}`);

    // Exclusivité vendue à quelqu'un d'autre (pour une exclusive comme pour une licence simple payée après) :
    // la commande est payée puis remboursée automatiquement. Ligne du morceau verrouillée pour toute commande.
    let refundReason: string | null = alreadyRefunded ? 'Remboursé depuis Stripe' : null;
    if (o.trackId) {
      const [t] = await tx<{ soldOrder: string | null }[]>`select exclusive_sold_order as "soldOrder" from tracks where id = ${o.trackId} for update`;
      if (t?.soldOrder && t.soldOrder !== o.id) refundReason ??= o.exclusive ? 'Exclusive déjà vendue : remboursement automatique'
        : 'Exclusivité vendue entre-temps : remboursement automatique';
      else if (o.exclusive && !refundReason) await tx`update tracks set exclusive_sold_at = ${now}, exclusive_sold_order = ${o.id},
        exclusive_reserved_until = null, exclusive_reserved_order = null where id = ${o.trackId}`;
    }
    const year = now.getUTCFullYear();
    const [{ no }] = await tx<{ no: number }[]>`insert into invoice_counters (series, last_no) values (${`F${year}`}, 1)
      on conflict (series) do update set last_no = invoice_counters.last_no + 1 returning last_no as no`;
    const due = new Date(now.getTime() + TRANSFER_DELAY_DAYS * 86400_000);
    // Deux preuves du pays : déclaré (base de la TVA) et carte. Un désaccord entre deux pays différents de l'UE, ou UE/hors UE, est signalé.
    const inEu = (c: string | null) => Boolean(c && Object.hasOwn(EU_VAT, c));
    const conflict = Boolean(cardCountry && cardCountry !== o.country && (inEu(cardCountry) || inEu(o.country)));
    await tx`update orders set status = 'paid', paid_at = ${now}, invoice_no = ${`F${year}-${String(no).padStart(6, '0')}`},
      payment_intent_id = ${pi?.id ?? null}, charge_id = ${charge?.id ?? null}, stripe_fee_cents = ${fee}, card_country = ${cardCountry},
      country_conflict = ${conflict}, transfers_due_at = ${due}, refund_requested_at = ${refundReason ? now : null},
      refund_reason = ${refundReason} where id = ${o.id}`;
    const splits = o.trackId ? await tx<{ userId: string; role: string; pct: number }[]>`
      select collaborator_id as "userId", accepted_role as role, accepted_pct::float as pct from track_splits
      where track_id = ${o.trackId} and accepted_pct is not null order by accepted_pct desc, collaborator_id` : [];
    const shares = computeShares({ netCents: o.netCents, commissionCents: o.commissionCents, feeCents: fee, ownerId: o.sellerId, splits });
    for (const s of shares) {
      await tx`insert into order_shares (order_id, user_id, is_owner, role, pct, amount_cents)
        values (${o.id}, ${s.userId}, ${s.isOwner}, ${s.role}, ${s.pct}, ${s.amountCents})`;
    }
    if (refundReason) await enqueue(tx, 'order_refund', { orderId: o.id });
    else {
      await enqueue(tx, 'order_deliver', { orderId: o.id });
      await enqueue(tx, 'order_transfers', { orderId: o.id }, due);
    }
    return { duplicate: false as const, refundNow: Boolean(refundReason), alreadyRefunded, orderId: o.id };
  });
  // Remboursement tout de suite ; s'il échoue, la tâche « order_refund » (puis le balayage) le reprend.
  if (!result.duplicate && result.refundNow) {
    await (result.alreadyRefunded ? afterRefund(result.orderId, 'Remboursé depuis Stripe', now) : refundOrder(result.orderId, now)).catch((e) => {
      console.error('remboursement automatique à reprendre', result.orderId, (e as Error).message);
    });
  }
}

// ───────── Remboursement ─────────

/** Le vendeur rembourse une de ses ventes. */
export async function refundBySeller(userId: string, orderId: string) {
  uuid.parse(orderId);
  const [o] = await withUser(userId, (tx) => tx<{ status: string }[]>`select status from orders where id = ${orderId} and seller_id = ${userId}`);
  if (!o) throw new NotFound();
  if (o.status !== 'paid') throw new Invalid('Cette vente est déjà remboursée.');
  // Une fois une part virée, seul Sonikc peut rembourser : sinon le producteur reprendrait l'argent de ses collaborateurs.
  const requested = await asPayments(async (tx) => {
    await tx`select 1 from orders where id = ${orderId} for update`;
    // Virement parti, en cours, ou peut-être parti (réponse de Stripe perdue) : plus de remboursement par le producteur.
    const [x] = await tx`select 1 from order_shares where order_id = ${orderId} and (status in ('transferring', 'transferred') or attempts > 0)`;
    if (x) return false;
    await tx`update orders set refund_requested_at = coalesce(refund_requested_at, now()),
      refund_reason = coalesce(refund_reason, 'Remboursé par le producteur') where id = ${orderId} and status = 'paid'`;
    return true;
  });
  if (!requested) throw new Invalid('Le virement est déjà parti : pour rembourser cette vente, écris au support de Sonikc.');
  await refundOrder(orderId);
}

/** Remboursement décidé par Sonikc (support, litige) : possible à tout moment, les parts virées sont reprises. */
export async function refundByPlatform(orderId: string, reason: string) {
  uuid.parse(orderId);
  await asPayments((tx) => tx`update orders set refund_requested_at = coalesce(refund_requested_at, now()),
    refund_reason = coalesce(refund_reason, ${reason}) where id = ${orderId} and status = 'paid'`);
  await refundOrder(orderId);
}

/**
 * Rembourse chez Stripe une commande dont le remboursement est demandé (une seule fois grâce à la clé d'idempotence ;
 * un remboursement déjà fait depuis le tableau de bord Stripe est accepté), puis en applique les effets.
 */
export async function refundOrder(orderId: string, now = new Date()) {
  const [o] = await asPayments((tx) => tx<{ pi: string | null; status: string; reason: string | null; requested: Date | null }[]>`
    select payment_intent_id as pi, status, refund_reason as reason, refund_requested_at as requested from orders where id = ${orderId}`);
  if (!o || o.status !== 'paid' || !o.pi || !o.requested) return;
  try {
    await stripe().refunds.create({ payment_intent: o.pi, metadata: { order_id: orderId } }, { idempotencyKey: `refund-${orderId}` });
  } catch (e) {
    if ((e as { code?: string }).code !== 'charge_already_refunded') throw e;
  }
  await afterRefund(orderId, o.reason ?? 'Remboursé', now);
}

/** Effets d'un remboursement (qu'il vienne de Sonikc ou du tableau de bord Stripe). Idempotent. */
export async function afterRefund(orderId: string, reason: string, now = new Date()) {
  await asPayments(async (tx) => {
    const [o] = await tx<{ status: string; trackId: string | null }[]>`select status, track_id as "trackId" from orders where id = ${orderId} for update`;
    if (!o || o.status !== 'paid') return;
    const year = now.getUTCFullYear();
    const [{ no }] = await tx<{ no: number }[]>`insert into invoice_counters (series, last_no) values (${`A${year}`}, 1)
      on conflict (series) do update set last_no = invoice_counters.last_no + 1 returning last_no as no`;
    await tx`update orders set status = 'refunded', refunded_at = ${now}, refund_reason = coalesce(refund_reason, ${reason}),
      credit_note_no = ${`A${year}-${String(no).padStart(6, '0')}`} where id = ${orderId}`;
    // Exclusive remboursée : le morceau peut de nouveau être vendu.
    if (o.trackId) await tx`update tracks set exclusive_sold_at = null, exclusive_sold_order = null where id = ${o.trackId} and exclusive_sold_order = ${orderId}`;
    // Avant le virement : la part prévue est annulée. Après : elle est reprise (ci-dessous, et par le balayage en cas d'échec).
    // (retry_at remis à zéro : une part dont un essai a peut-être abouti est vérifiée chez Stripe tout de suite.)
    await tx`update order_shares set status = 'canceled', retry_at = null where order_id = ${orderId} and status in ('scheduled', 'held', 'disputed')`;
    await enqueue(tx, 'order_credit_note', { orderId });
  });
  await reverseShares(orderId);
}

/** Reprend chaque part déjà virée d'une commande remboursée. Un échec reste « virée » et sera retenté. */
export async function reverseShares(orderId: string) {
  // Parts annulées après un essai dont la réponse s'est perdue : le virement est peut-être parti, on vérifie chez Stripe.
  const doubtful = await asPayments((tx) => tx<{ userId: string }[]>`select s.user_id as "userId" from order_shares s join orders o on o.id = s.order_id
    where s.order_id = ${orderId} and o.status = 'refunded' and s.status = 'canceled' and s.attempts > 0 and s.transfer_id is null
      and (s.retry_at is null or s.retry_at <= now())`);
  for (const d of doubtful) {
    try {
      const tr = await findTransfer(orderId, d.userId);
      await asPayments((tx) => tr
        ? tx`update order_shares set status = 'transferred', transfer_id = ${tr.id} where order_id = ${orderId} and user_id = ${d.userId} and status = 'canceled'`
        : tx`update order_shares set retry_at = 'infinity', last_error = 'vérifié : aucun virement parti' where order_id = ${orderId} and user_id = ${d.userId}`);
    } catch (e) {
      await asPayments((tx) => tx`update order_shares set retry_at = now() + interval '1 hour', last_error = ${(e as Error).message.slice(0, 500)}
        where order_id = ${orderId} and user_id = ${d.userId}`);
    }
  }
  const rows = await asPayments((tx) => tx<{ userId: string; transferId: string; attempts: number }[]>`
    select s.user_id as "userId", s.transfer_id as "transferId", s.attempts from order_shares s join orders o on o.id = s.order_id
    where s.order_id = ${orderId} and o.status = 'refunded' and s.status = 'transferred'`);
  let failed = 0;
  for (const s of rows) {
    try {
      // Un essai précédent a pu aboutir sans que la réponse arrive : on relit le virement avant de recommencer.
      const tr = await stripe().transfers.retrieve(s.transferId);
      if (!tr.reversed && (tr.amount_reversed ?? 0) < tr.amount) {
        await stripe().transfers.createReversal(s.transferId, { metadata: { order_id: orderId } }, { idempotencyKey: `reversal-${orderId}-${s.userId}-${s.attempts}` });
      }
      await asPayments((tx) => tx`update order_shares set status = 'reversed', last_error = null where order_id = ${orderId} and user_id = ${s.userId}`);
    } catch (e) {
      failed++;
      await asPayments((tx) => tx`update order_shares set attempts = attempts + 1, retry_at = now() + interval '1 hour',
        last_error = ${(e as Error).message.slice(0, 500)} where order_id = ${orderId} and user_id = ${s.userId}`);
    }
  }
  return { failed };
}

// ───────── Virements (14 jours après le paiement) ─────────

/** Cherche chez Stripe un virement déjà fait pour cette part (réponse perdue lors d'un essai précédent). */
async function findTransfer(orderId: string, userId: string) {
  const list = await stripe().transfers.list({ transfer_group: orderId, limit: 100 });
  return list.data.find((t) => t.metadata?.user_id === userId);
}

/**
 * Vire chaque part due. Sans compte de reversement actif, la part reste « en attente » (rien n'est perdu) et
 * repasse le lendemain ; une erreur de Stripe la fait repasser une heure plus tard. Avant l'appel à Stripe, la part
 * est réservée (« en cours ») sous verrou de la commande : un remboursement ne peut pas s'intercaler.
 * Le balayage (`sweepPayments`) reprend tout ce qui est dû ou resté « en cours » : aucune part n'est abandonnée.
 */
export async function runTransfers(orderId: string, now = new Date()) {
  const [o] = await asPayments((tx) => tx<{ status: string; chargeId: string | null; due: Date | null; disputed: Date | null; refunding: Date | null }[]>`
    select status, charge_id as "chargeId", transfers_due_at as due, disputed_at as disputed, refund_requested_at as refunding from orders where id = ${orderId}`);
  if (!o || o.status !== 'paid' || o.disputed || o.refunding || !o.due || o.due.getTime() > now.getTime()) return { transferred: 0, held: 0, failed: 0 };
  const shares = await asPayments((tx) => tx<{ userId: string; amountCents: number; attempts: number; accountId: string | null; active: boolean | null }[]>`
    select s.user_id as "userId", s.amount_cents as "amountCents", s.attempts, a.account_id as "accountId", a.transfers_active as active
    from order_shares s left join stripe_accounts a on a.user_id = s.user_id
    where s.order_id = ${orderId} and s.status in ('scheduled', 'held') and (s.retry_at is null or s.retry_at <= ${now})`);
  let transferred = 0, held = 0, failed = 0;
  for (const s of shares) {
    if (s.amountCents === 0) { await asPayments((tx) => tx`update order_shares set status = 'canceled' where order_id = ${orderId} and user_id = ${s.userId} and status in ('scheduled', 'held')`); continue; }
    let active = Boolean(s.active);
    try {
      if (s.accountId && !active) active = (await refreshAccountById(s.userId, s.accountId)).transfersActive;
    } catch { active = false; }
    if (!s.accountId || !active) {
      held++;
      await asPayments((tx) => tx`update order_shares set status = 'held', retry_at = ${now}::timestamptz + interval '1 day'
        where order_id = ${orderId} and user_id = ${s.userId} and status in ('scheduled', 'held')`);
      continue;
    }
    // Réservation sous verrou : commande toujours payée, aucun remboursement demandé, pas de litige.
    const claimed = await asPayments(async (tx) => {
      const [x] = await tx<{ ok: boolean }[]>`select (status = 'paid' and refund_requested_at is null and disputed_at is null) as ok
        from orders where id = ${orderId} for update`;
      if (!x?.ok) return false;
      return (await tx`update order_shares set status = 'transferring' where order_id = ${orderId} and user_id = ${s.userId}
        and status in ('scheduled', 'held') returning 1`).length > 0;
    });
    if (!claimed) continue;
    try {
      let tr: Stripe.Transfer | undefined = s.attempts > 0 ? await findTransfer(orderId, s.userId) : undefined;
      tr ??= await stripe().transfers.create({
        amount: s.amountCents, currency: 'eur', destination: s.accountId!, transfer_group: orderId,
        ...(o.chargeId ? { source_transaction: o.chargeId } : {}), metadata: { order_id: orderId, user_id: s.userId },
      }, { idempotencyKey: `transfer-${orderId}-${s.userId}-${s.attempts}` });
      const refunded = await asPayments(async (tx) => {
        await tx`update order_shares set status = 'transferred', transfer_id = ${tr!.id}, retry_at = null, last_error = null
          where order_id = ${orderId} and user_id = ${s.userId} and status = 'transferring'`;
        const [x] = await tx<{ status: string }[]>`select status from orders where id = ${orderId}`;
        return x.status === 'refunded';
      });
      // Remboursé par Sonikc pendant l'envoi : la part qui vient de partir est aussitôt reprise.
      if (refunded) await reverseShares(orderId);
      else transferred++;
    } catch (e) {
      failed++;
      await asPayments((tx) => tx`update order_shares set status = 'scheduled', attempts = attempts + 1, retry_at = ${now}::timestamptz + interval '1 hour',
        last_error = ${(e as Error).message.slice(0, 500)} where order_id = ${orderId} and user_id = ${s.userId} and status = 'transferring'`);
    }
  }
  return { transferred, held, failed };
}

/** Parts restées « en cours » (arrêt pendant l'appel à Stripe) : on regarde chez Stripe si le virement est parti. */
async function recoverTransferring(now: Date) {
  const rows = await asPayments((tx) => tx<{ orderId: string; userId: string }[]>`select order_id as "orderId", user_id as "userId" from order_shares
    where status = 'transferring' and updated_at < ${now}::timestamptz - interval '15 minutes' limit 100`);
  for (const r of rows) {
    try {
      const tr = await findTransfer(r.orderId, r.userId);
      await asPayments((tx) => tr
        ? tx`update order_shares set status = 'transferred', transfer_id = ${tr.id}, retry_at = null where order_id = ${r.orderId} and user_id = ${r.userId} and status = 'transferring'`
        : tx`update order_shares set status = 'scheduled', attempts = attempts + 1, retry_at = null where order_id = ${r.orderId} and user_id = ${r.userId} and status = 'transferring'`);
    } catch (e) { console.error('part en cours', r.orderId, (e as Error).message); }
  }
}

/**
 * Balayage (worker, toutes les 10 min) : parts restées « en cours », remboursements demandés non confirmés,
 * parts dues non virées, reprises non faites, emails de livraison non partis.
 */
export async function sweepPayments(now = new Date()) {
  await recoverTransferring(now);
  const refunds = await asPayments((tx) => tx<{ id: string }[]>`select id from orders
    where status = 'paid' and refund_requested_at is not null and refund_requested_at < ${now}::timestamptz - interval '5 minutes' limit 100`);
  for (const o of refunds) await refundOrder(o.id, now).catch((e) => console.error('remboursement', o.id, (e as Error).message));
  const transfers = await asPayments((tx) => tx<{ id: string }[]>`select distinct o.id from orders o join order_shares s on s.order_id = o.id
    where o.status = 'paid' and o.refund_requested_at is null and o.disputed_at is null and o.transfers_due_at <= ${now}
      and s.status in ('scheduled', 'held') and (s.retry_at is null or s.retry_at <= ${now}) limit 200`);
  for (const o of transfers) await runTransfers(o.id, now).catch((e) => console.error('virement', o.id, (e as Error).message));
  const reversals = await asPayments((tx) => tx<{ id: string }[]>`select distinct o.id from orders o join order_shares s on s.order_id = o.id
    where o.status = 'refunded' and (s.status = 'transferred' or (s.status = 'canceled' and s.attempts > 0 and s.transfer_id is null))
      and (s.retry_at is null or s.retry_at <= ${now}) limit 200`);
  // (Une part annulée dont on a vérifié qu'aucun virement n'est parti a retry_at = infinity : elle n'est plus reprise.)
  for (const o of reversals) await reverseShares(o.id).catch((e) => console.error('reprise', o.id, (e as Error).message));
  const undelivered = await asPayments((tx) => tx<{ id: string }[]>`select id from orders where status = 'paid' and refund_requested_at is null
    and buyer_notified_at is null and paid_at < ${now}::timestamptz - interval '15 minutes'
    and not exists (select 1 from jobs j where j.kind = 'order_deliver' and j.payload->>'orderId' = orders.id::text and j.status in ('queued', 'running'))
    limit 100`);
  for (const o of undelivered) await asPayments((tx) => enqueue(tx, 'order_deliver', { orderId: o.id }));
  return { refunds: refunds.length, transfers: transfers.length, reversals: reversals.length, deliveries: undelivered.length };
}

// ───────── Comptes de reversement (Stripe Connect Express) ─────────

export async function payoutAccount(userId: string) {
  const [a] = await withUser(userId, (tx) => tx<{ accountId: string; transfersActive: boolean; detailsSubmitted: boolean }[]>`
    select account_id as "accountId", transfers_active as "transfersActive", details_submitted as "detailsSubmitted" from stripe_accounts where user_id = ${userId}`);
  return a ?? null;
}

/** Crée (une seule fois) le compte Express du producteur et rend l'adresse du formulaire d'activation chez Stripe. */
export async function startOnboarding(userId: string, rawCountry: unknown = env().STRIPE_CONNECT_COUNTRY) {
  const acctCountry = z.string().refine((c) => Object.hasOwn(EU_VAT, c), 'Pays invalide.').parse(rawCountry);
  let [a] = await asPayments((tx) => tx<{ accountId: string }[]>`select account_id as "accountId" from stripe_accounts where user_id = ${userId}`);
  if (!a) {
    // Propriétés de contrôle (au lieu de l'ancien « type ») : tableau de bord Express, informations collectées par Stripe,
    // et Stripe porte le risque de solde négatif du compte (exigé par Stripe pour cette plateforme ; moins de risque pour Sonikc).
    const acct = await stripe().accounts.create({
      country: acctCountry,
      controller: {
        stripe_dashboard: { type: 'express' }, requirement_collection: 'stripe',
        losses: { payments: 'stripe' }, fees: { payer: 'account' },
      },
      capabilities: { transfers: { requested: true } },
      metadata: { user_id: userId },
    }, { idempotencyKey: `account-${userId}` });
    await asPayments((tx) => tx`insert into stripe_accounts (user_id, account_id, country) values (${userId}, ${acct.id}, ${acctCountry})
      on conflict (user_id) do nothing`);
    [a] = await asPayments((tx) => tx<{ accountId: string }[]>`select account_id as "accountId" from stripe_accounts where user_id = ${userId}`);
  }
  const link = await stripe().accountLinks.create({
    account: a.accountId, type: 'account_onboarding',
    refresh_url: `${env().APP_URL}/app/ventes?connect=relancer`, return_url: `${env().APP_URL}/app/ventes?connect=retour`,
  });
  return { url: link.url };
}

export async function refreshAccount(userId: string) {
  const [a] = await asPayments((tx) => tx<{ accountId: string }[]>`select account_id as "accountId" from stripe_accounts where user_id = ${userId}`);
  return a ? refreshAccountById(userId, a.accountId) : null;
}

async function refreshAccountById(userId: string, accountId: string) {
  const acct = await stripe().accounts.retrieve(accountId);
  const transfersActive = acct.capabilities?.transfers === 'active' && Boolean(acct.payouts_enabled);
  const wasActive = await asPayments(async (tx) => {
    const [prev] = await tx<{ active: boolean }[]>`select transfers_active as active from stripe_accounts where user_id = ${userId} for update`;
    await tx`update stripe_accounts set transfers_active = ${transfersActive}, details_submitted = ${Boolean(acct.details_submitted)}, updated_at = now()
      where user_id = ${userId}`;
    // Compte tout juste activé : les parts en attente partent maintenant (une seule tâche en file par commande).
    if (transfersActive && !prev?.active) {
      const held = await tx<{ orderId: string }[]>`update order_shares set retry_at = null where user_id = ${userId} and status = 'held'
        returning order_id as "orderId"`;
      for (const orderId of new Set(held.map((h) => h.orderId))) {
        const [q] = await tx`select 1 from jobs where kind = 'order_transfers' and payload->>'orderId' = ${orderId} and status = 'queued' and run_after <= now()`;
        if (!q) await enqueue(tx, 'order_transfers', { orderId });
      }
    }
    return Boolean(prev?.active);
  });
  return { transfersActive, detailsSubmitted: Boolean(acct.details_submitted), justActivated: transfersActive && !wasActive };
}

// ───────── Lecture : ventes, parts, achats ─────────

export type SaleRow = {
  id: string; createdAt: Date; paidAt: Date; trackTitle: string; licenceName: string; buyerEmail: string | null; country: string;
  grossCents: number; netCents: number; vatCents: number; commissionCents: number; feeCents: number; status: string;
  invoiceNo: string; myShareCents: number; myShareStatus: string; isSeller: boolean; transfersDueAt: Date; refundable: boolean;
  shares: { handle: string; pct: number; amountCents: number; status: string; isOwner: boolean }[];
};

export async function listSales(userId: string): Promise<SaleRow[]> {
  return withUser(userId, async (tx) => {
    const rows = await tx<Omit<SaleRow, 'shares'>[]>`
      select o.id, o.created_at as "createdAt", o.paid_at as "paidAt", o.track_title as "trackTitle", o.licence->>'name' as "licenceName",
             case when o.seller_id = ${userId} then o.buyer_email else null end as "buyerEmail", o.country, o.gross_cents as "grossCents", o.net_cents as "netCents", o.vat_cents as "vatCents",
             o.commission_cents as "commissionCents", coalesce(o.stripe_fee_cents, 0) as "feeCents", o.status, o.invoice_no as "invoiceNo",
             s.amount_cents as "myShareCents", s.status as "myShareStatus", o.seller_id = ${userId} as "isSeller", o.transfers_due_at as "transfersDueAt",
             (o.seller_id = ${userId} and o.status = 'paid' and o.refund_requested_at is null and not exists (select 1 from order_shares x
               where x.order_id = o.id and (x.status in ('transferring', 'transferred') or x.attempts > 0))) as refundable
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
  return asPayments(async (tx) => {
    const [o] = await tx<{ id: string; status: string; trackTitle: string; sellerName: string; licence: Record<string, unknown>; buyerEmail: string;
      country: string; netCents: number; vatRate: number; vatCents: number; grossCents: number; invoiceNo: string | null; creditNoteNo: string | null;
      paidAt: Date | null; refundedAt: Date | null; deliveredAt: Date | null; refundRequestedAt: Date | null }[]>`
      select id, status, track_title as "trackTitle", seller_name as "sellerName", licence, buyer_email as "buyerEmail", country,
             net_cents as "netCents", vat_rate::float as "vatRate", vat_cents as "vatCents", gross_cents as "grossCents", invoice_no as "invoiceNo",
             credit_note_no as "creditNoteNo", paid_at as "paidAt", refunded_at as "refundedAt", delivered_at as "deliveredAt",
             refund_requested_at as "refundRequestedAt"
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
  const [f] = await asPayments((tx) => tx<{ key: string; filename: string; status: string }[]>`
    select f.storage_key as key, f.filename, o.status from order_files f join orders o on o.id = f.order_id
    where f.order_id = ${orderId} and f.kind = ${kind}`);
  if (!f) return null;
  if (f.status !== 'paid' && !['invoice', 'credit_note'].includes(kind)) return null;
  return f;
}

export type CommerceTx = Tx;
