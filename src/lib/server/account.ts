import { z } from 'zod';
import { asAccount, withUser, type Tx } from './db';
import { Invalid, NotFound } from './library';
import { store } from './storage';
import { stripe } from './stripe';
import { syncCustomer } from './billing';
import { refreshAccount } from './commerce';

/**
 * Lot 5.3 — droits sur les données : export complet en JSON et suppression du compte.
 * L'export passe par l'accès utilisateur (RLS) pour tes propres lignes ; les lignes où tu apparais chez d'autres
 * (tes écoutes, tes achats, tes parts) sont lues par l'accès « compte » (asAccount), colonnes choisies une à une.
 * La suppression passe aussi par l'accès « compte » : la base ne lui montre que les lignes du compte supprimé.
 */

// Jamais exportés : secrets, emplacements internes des fichiers, identifiants techniques d'autres personnes.
const HIDDEN = ['password_hash', 'original_key', 'preview_key', 'storage_key', 'token_hash', 'ip_hash', 'visitor', 'listener_keys', 'waveform'];
const strip = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([k]) => !HIDDEN.includes(k)));
type Rows = { r: Record<string, unknown> }[];

/** Tes lignes (accès utilisateur : la base ne rend que les tiennes). */
const OWN: { name: string; q: (tx: Tx, uid: string) => Promise<Rows> }[] = [
  { name: 'profil', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from profiles t where user_id = ${uid}` },
  { name: 'dossiers', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from folders t where owner_id = ${uid}` },
  { name: 'morceaux', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from tracks t where owner_id = ${uid}` },
  { name: 'versions', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from track_versions t where owner_id = ${uid}` },
  { name: 'imports', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from imports t where owner_id = ${uid}` },
  { name: 'projets', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from projects t where owner_id = ${uid}` },
  { name: 'morceaux_des_projets', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from project_tracks t where owner_id = ${uid}` },
  { name: 'liens_de_partage', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from share_links t where owner_id = ${uid}` },
  { name: 'invitations', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from invites t where owner_id = ${uid}` },
  { name: 'ecoutes_de_tes_morceaux', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from listen_sessions t where owner_id = ${uid}` },
  { name: 'ouvertures_de_tes_liens', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from link_views t where owner_id = ${uid}` },
  { name: 'interactions_sur_tes_morceaux', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from interactions t where owner_id = ${uid}` },
  { name: 'notifications', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from notifications t where owner_id = ${uid}` },
  { name: 'recus', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from saves t where user_id = ${uid}` },
  { name: 'contacts', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from contacts t where owner_id = ${uid}` },
  { name: 'groupes', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from contact_groups t where owner_id = ${uid}` },
  { name: 'membres_des_groupes', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from contact_group_members t where owner_id = ${uid}` },
  { name: 'envois', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from campaigns t where owner_id = ${uid}` },
  { name: 'emails_envoyes', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from email_sends t where owner_id = ${uid}` },
  { name: 'desinscrits', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from email_suppressions t where owner_id = ${uid}` },
  { name: 'licences', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from licence_templates t where owner_id = ${uid}` },
  { name: 'licences_par_morceau', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from track_licences t where owner_id = ${uid}` },
  { name: 'abonnement', q: (tx, uid) => tx<Rows>`select jsonb_build_object('offre', plan, 'periode', period, 'statut', status, 'pays', country,
      'fin_de_periode', current_period_end, 'fin_essai', trial_end, 'resiliation_en_fin_de_periode', cancel_at_period_end, 'essai_utilise', trial_used) as r
      from subscriptions where user_id = ${uid}` },
];

/** Là où tu apparais chez d'autres : colonnes choisies, rien d'autre que ce qui te concerne. */
const ELSEWHERE: { name: string; q: (tx: Tx, uid: string, email: string) => Promise<Rows> }[] = [
  { name: 'tes_ecoutes', q: (tx, uid) => tx<Rows>`select jsonb_build_object('morceau', track_id, 'lien', link_id, 'debut', started_at,
      'duree_ms', listened_ms, 'source', source, 'nom_affiche', listener_name) as r from listen_sessions where listener_id = ${uid}` },
  { name: 'tes_ouvertures_de_liens', q: (tx, uid) => tx<Rows>`select jsonb_build_object('lien', link_id, 'date', created_at) as r
      from link_views where listener_id = ${uid}` },
  { name: 'tes_telechargements_et_favoris', q: (tx, uid) => tx<Rows>`select jsonb_build_object('morceau', track_id, 'lien', link_id, 'type', kind,
      'date', created_at) as r from interactions where listener_id = ${uid}` },
  { name: 'tes_collaborations', q: (tx, uid) => tx<Rows>`select jsonb_build_object('morceau', track_id, 'producteur', owner_id, 'collaborateur', collaborator_id,
      'role', role, 'pourcentage', pct, 'statut', status, 'pourcentage_accepte', accepted_pct, 'invite_le', invited_at) as r
      from track_splits where owner_id = ${uid} or collaborator_id = ${uid}` },
  { name: 'ventes', q: (tx, uid) => tx<Rows>`select to_jsonb(t) - 'ip_hash' as r from orders t where seller_id = ${uid} and status in ('paid', 'refunded')` },
  { name: 'parts_des_ventes', q: (tx, uid) => tx<Rows>`select to_jsonb(t) as r from order_shares t where user_id = ${uid}` },
  { name: 'achats', q: (tx, uid, email) => tx<Rows>`select jsonb_build_object('commande', id, 'morceau', track_title, 'vendeur', seller_name,
      'licence', licence, 'exclusive', exclusive, 'email', buyer_email, 'pays', country, 'prix_ht_centimes', net_cents, 'tva_pourcent', vat_rate,
      'tva_centimes', vat_cents, 'prix_ttc_centimes', gross_cents, 'facture', invoice_no, 'avoir', credit_note_no, 'paye_le', paid_at,
      'rembourse_le', refunded_at) as r
      from orders where status in ('paid', 'refunded') and (buyer_user_id = ${uid} or lower(buyer_email) = lower(${email}))` },
  { name: 'certificats', q: (tx, uid, email) => tx<Rows>`select to_jsonb(c) as r from licence_certificates c join orders o on o.id = c.order_id
      where o.seller_id = ${uid} or o.buyer_user_id = ${uid} or lower(o.buyer_email) = lower(${email})` },
  { name: 'compte_de_reversement', q: (tx, uid) => tx<Rows>`select jsonb_build_object('compte_stripe', account_id, 'virements_actifs', transfers_active,
      'mis_a_jour_le', updated_at) as r from stripe_accounts where user_id = ${uid}` },
];

/** Toutes tes données, en un seul fichier JSON. */
export async function exportAccount(userId: string) {
  const [u] = await asAccount(userId, (tx) => tx<{ email: string; googleSub: string | null; createdAt: Date; deletedAt: Date | null }[]>`
    select email, google_sub as "googleSub", created_at as "createdAt", deleted_at as "deletedAt" from users where id = ${userId}`);
  if (!u || u.deletedAt) throw new NotFound();
  const data: Record<string, unknown[]> = {};
  await withUser(userId, async (tx) => {
    for (const t of OWN) data[t.name] = (await t.q(tx, userId)).map((x) => strip(x.r));
  });
  await asAccount(userId, async (tx) => {
    for (const t of ELSEWHERE) data[t.name] = (await t.q(tx, userId, u.email)).map((x) => strip(x.r));
  });
  return {
    format: 'sonikc-export-1',
    exportedAt: new Date().toISOString(),
    note: 'Fichiers audio non inclus : télécharge-les depuis ta bibliothèque. Les ventes et factures restent conservées 10 ans (obligation légale).',
    compte: { id: userId, email: u.email, connexionGoogle: Boolean(u.googleSub), creeLe: u.createdAt.toISOString() },
    ...data,
  };
}

/**
 * Supprime le compte. Tes morceaux, fichiers, partages, contacts, envois, statistiques et sessions sont effacés.
 * Ce qui reste, pour la loi ou pour d'autres personnes : tes ventes et factures (10 ans), les parts dues à tes
 * collaborateurs et ton compte de reversement Stripe (pour les virements en cours), les achats déjà livrés à tes clients.
 * Dans ce cas, la ligne du compte reste sans email, sans connexion Google ni profil reconnaissables, et ton
 * identifiant n'est jamais réattribué (il figure sur les licences déjà émises).
 * Refusée tant qu'une vente est en cours de paiement ou pas encore livrée (l'acheteur doit recevoir ses fichiers).
 * Si de l'argent de ventes t'est dû sans compte de reversement : refusée, sauf si tu y renonces explicitement.
 */
export async function deleteAccount(userId: string, confirm: unknown, opts: { renounceCents?: number } = {}) {
  const [p] = await withUser(userId, (tx) => tx<{ handle: string }[]>`select handle from profiles where user_id = ${userId}`);
  const [u] = await asAccount(userId, (tx) => tx<{ email: string; deletedAt: Date | null }[]>`select email, deleted_at as "deletedAt" from users where id = ${userId}`);
  if (!u || u.deletedAt) throw new NotFound();
  const expected = p?.handle ?? u.email;
  if (z.string().trim().toLowerCase().safeParse(confirm).data !== expected.toLowerCase()) {
    throw new Invalid(`Pour confirmer, tape exactement : ${expected}`);
  }
  // Renonciation : vaut pour le montant que tu as vu (pas pour une vente arrivée entre-temps).
  const renounceCents = Number.isInteger(opts.renounceCents) && opts.renounceCents! > 0 ? opts.renounceCents! : 0;
  // Compte de reversement : état relu chez Stripe (la valeur gardée peut dater), pour ne pas te dire « active » à tort.
  await refreshAccount(userId).catch(() => null);
  await asAccount(userId, async (tx) => {
    if (await openSales(tx, userId)) throw new Invalid(SALE_PENDING);
    await moneyOwed(tx, renounceCents);
  });

  // 1. Abonnement. D'abord l'état relu chez Stripe (l'essai éventuel est noté : il reste unique par personne),
  //    puis le client Stripe est supprimé (abonnement arrêté tout de suite, plus de données chez Stripe).
  const [sub] = await asAccount(userId, (tx) => tx<{ customerId: string }[]>`select customer_id as "customerId" from subscriptions where user_id = ${userId}`);
  if (sub) {
    // Client déjà supprimé chez Stripe (essai précédent, ou supprimé à la main) : rien à relire, l'essai était déjà noté.
    await syncCustomer(sub.customerId).catch((e: { code?: string }) => { if (e?.code !== 'resource_missing') throw e; });
    await stripe().customers.del(sub.customerId, {}, { idempotencyKey: `delete-account-${userId}` }).catch((e: { code?: string }) => {
      if (e?.code !== 'resource_missing') throw e;
    });
  }

  // 2. Base, en une transaction ; les écritures passent par une fonction de la base limitée au compte courant.
  const outcome = await asAccount(userId, async (tx) => {
    // Verrou sur tes morceaux : un achat qui commence en même temps attend, puis échoue proprement.
    await tx`select id from tracks where owner_id = ${userId} for update`;
    if (await openSales(tx, userId)) throw new Invalid(SALE_PENDING);
    const renounced = await moneyOwed(tx, renounceCents);
    // Fichiers à effacer, relevés dans la transaction (aucun envoi terminé entre-temps n'est oublié).
    const files = await tx<{ k: string | null }[]>`select original_key as k from track_versions where owner_id = ${userId}
      union all select preview_key from track_versions where owner_id = ${userId}
      union all select original_key from imports where owner_id = ${userId}`;
    const keys = [...new Set(files.map((x) => x.k).filter((k): k is string => Boolean(k && k !== 'pending')))];
    if (keys.length) await tx`insert into pending_file_removals ${tx(keys.map((key) => ({ key })))}`; // clés propres à ce compte : jamais en double
    // Ventes, parts ou compte de reversement à garder pour la loi : compte anonymisé ; sinon effacé entièrement.
    const [{ keep }] = await tx<{ keep: boolean }[]>`select (
      exists (select 1 from orders where seller_id = ${userId}) or exists (select 1 from order_shares where user_id = ${userId})
      or exists (select 1 from stripe_accounts where user_id = ${userId})) as keep`;
    await tx`select app.erase_account(${keep}, ${renounced})`;
    return { outcome: keep ? 'anonymized' as const : 'deleted' as const, keys };
  });

  // 3. Fichiers (après la base). Ce qui échoue reste noté et sera repris par le worker.
  await removePendingFiles(outcome.keys);
  return { outcome: outcome.outcome, filesRemoved: outcome.keys.length };
}

const SALE_PENDING = 'Une de tes ventes est en cours (paiement ou livraison des fichiers) : réessaie dans une heure.';

/** Une vente du compte (comme vendeur) est-elle en cours de paiement, ou payée mais pas encore livrée ? */
async function openSales(tx: Tx, userId: string) {
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from orders where seller_id = ${userId}
    and ((status = 'pending' and created_at > now() - interval '1 hour') or (status = 'paid' and delivered_at is null))`;
  return n > 0;
}

/** Erreur « de l'argent t'est dû » : le montant, et le choix entre activer ses reversements ou y renoncer. */
export class MoneyOwed extends Invalid {
  constructor(readonly cents: number, message: string) { super(message); }
}

/**
 * De l'argent de ventes t'est dû mais ne peut pas t'être versé (pas de compte de reversement actif) : on te le dit
 * et tu choisis — activer tes reversements pour le toucher, ou y renoncer explicitement et supprimer quand même.
 * Ne comptent pas : parts bloquées par un litige, ventes dont le remboursement est demandé.
 */
async function moneyOwed(tx: Tx, renounceCents: number) {
  const [{ cents }] = await tx<{ cents: number }[]>`select app.account_money_owed() as cents`;
  if (cents === 0) return false;
  if (cents <= renounceCents) return true;
  const amount = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / 100);
  throw new MoneyOwed(cents, `Il te reste ${amount} de ventes à recevoir. Active tes reversements (Ventes → « Activer mes reversements ») pour les toucher, ou coche « Je renonce » pour supprimer quand même.`);
}

/** Efface les fichiers notés (ceux donnés, ou les plus anciens en attente) ; rend le nombre effacé. Lancé aussi par le worker. */
export async function removePendingFiles(keys?: string[]) {
  const todo = keys ?? (await asAccount(null, (tx) => tx<{ key: string }[]>`select key from pending_file_removals order by created_at limit 500`)).map((r) => r.key);
  let removed = 0;
  for (let i = 0; i < todo.length; i += 100) {
    const batch = todo.slice(i, i + 100);
    try {
      await store().remove(batch);
      await asAccount(null, (tx) => tx`delete from pending_file_removals where key = any(${batch})`);
      removed += batch.length;
    } catch {
      await asAccount(null, (tx) => tx`update pending_file_removals set attempts = attempts + 1 where key = any(${batch})`);
    }
  }
  return removed;
}
