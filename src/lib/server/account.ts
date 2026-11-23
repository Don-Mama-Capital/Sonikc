import { z } from 'zod';
import { asPayments, asService, withUser, type Tx } from './db';
import { Invalid, NotFound } from './library';
import { store } from './storage';
import { stripe } from './stripe';

/**
 * Lot 5.3 — droits sur les données : export complet en JSON et suppression du compte.
 * La suppression relève du compte (comme la connexion) : accès service, une seule transaction.
 */

// Ce qu'on n'exporte pas : secrets et emplacements internes des fichiers (inutiles hors de Sonikc).
const HIDDEN = ['password_hash', 'original_key', 'preview_key', 'storage_key', 'token_hash', 'ip_hash'];

/** Tables lues pour l'export, avec la condition qui désigne « tes » lignes. */
const EXPORT: { name: string; where: (tx: Tx, uid: string) => ReturnType<Tx> }[] = [
  { name: 'profil', where: (tx, uid) => tx`select to_jsonb(t) as r from profiles t where user_id = ${uid}` },
  { name: 'dossiers', where: (tx, uid) => tx`select to_jsonb(t) as r from folders t where owner_id = ${uid}` },
  { name: 'morceaux', where: (tx, uid) => tx`select to_jsonb(t) as r from tracks t where owner_id = ${uid}` },
  { name: 'versions', where: (tx, uid) => tx`select to_jsonb(t) - 'waveform' as r from track_versions t where owner_id = ${uid}` },
  { name: 'projets', where: (tx, uid) => tx`select to_jsonb(t) as r from projects t where owner_id = ${uid}` },
  { name: 'morceaux_des_projets', where: (tx, uid) => tx`select to_jsonb(t) as r from project_tracks t where owner_id = ${uid}` },
  { name: 'liens_de_partage', where: (tx, uid) => tx`select to_jsonb(t) as r from share_links t where owner_id = ${uid}` },
  { name: 'invitations', where: (tx, uid) => tx`select to_jsonb(t) as r from invites t where owner_id = ${uid}` },
  { name: 'ecoutes_de_tes_morceaux', where: (tx, uid) => tx`select to_jsonb(t) as r from listen_sessions t where owner_id = ${uid}` },
  { name: 'tes_ecoutes', where: (tx, uid) => tx`select to_jsonb(t) as r from listen_sessions t where listener_id = ${uid}` },
  { name: 'ouvertures_de_liens', where: (tx, uid) => tx`select to_jsonb(t) as r from link_views t where owner_id = ${uid}` },
  { name: 'interactions', where: (tx, uid) => tx`select to_jsonb(t) as r from interactions t where owner_id = ${uid}` },
  { name: 'notifications', where: (tx, uid) => tx`select to_jsonb(t) as r from notifications t where owner_id = ${uid}` },
  { name: 'recus', where: (tx, uid) => tx`select to_jsonb(t) as r from saves t where user_id = ${uid}` },
  { name: 'contacts', where: (tx, uid) => tx`select to_jsonb(t) as r from contacts t where owner_id = ${uid}` },
  { name: 'groupes', where: (tx, uid) => tx`select to_jsonb(t) as r from contact_groups t where owner_id = ${uid}` },
  { name: 'envois', where: (tx, uid) => tx`select to_jsonb(t) as r from campaigns t where owner_id = ${uid}` },
  { name: 'emails_envoyes', where: (tx, uid) => tx`select to_jsonb(t) as r from email_sends t where owner_id = ${uid}` },
  { name: 'desinscrits', where: (tx, uid) => tx`select to_jsonb(t) as r from email_suppressions t where owner_id = ${uid}` },
  { name: 'licences', where: (tx, uid) => tx`select to_jsonb(t) as r from licence_templates t where owner_id = ${uid}` },
  { name: 'licences_par_morceau', where: (tx, uid) => tx`select to_jsonb(t) as r from track_licences t where owner_id = ${uid}` },
  { name: 'collaborateurs', where: (tx, uid) => tx`select to_jsonb(t) as r from track_splits t where owner_id = ${uid} or collaborator_id = ${uid}` },
  { name: 'ventes', where: (tx, uid) => tx`select to_jsonb(t) as r from orders t where seller_id = ${uid} and status in ('paid', 'refunded')` },
  { name: 'parts_des_ventes', where: (tx, uid) => tx`select to_jsonb(t) as r from order_shares t where user_id = ${uid}` },
  { name: 'achats', where: (tx, uid) => tx`select to_jsonb(t) as r from orders t where buyer_user_id = ${uid} and status in ('paid', 'refunded')` },
  { name: 'compte_de_reversement', where: (tx, uid) => tx`select to_jsonb(t) as r from stripe_accounts t where user_id = ${uid}` },
  { name: 'abonnement', where: (tx, uid) => tx`select to_jsonb(t) as r from subscriptions t where user_id = ${uid}` },
];

const strip = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([k]) => !HIDDEN.includes(k)));

/** Toutes tes données, en un seul fichier JSON. */
export async function exportAccount(userId: string) {
  const [u] = await asService((tx) => tx<{ email: string; createdAt: Date; deletedAt: Date | null }[]>`
    select email, created_at as "createdAt", deleted_at as "deletedAt" from users where id = ${userId}`);
  if (!u || u.deletedAt) throw new NotFound();
  const data: Record<string, unknown[]> = {};
  await asService(async (tx) => {
    for (const t of EXPORT) data[t.name] = ((await t.where(tx, userId)) as unknown as { r: Record<string, unknown> }[]).map((x) => strip(x.r));
  });
  return {
    format: 'sonikc-export-1',
    exportedAt: new Date().toISOString(),
    note: 'Fichiers audio non inclus : télécharge-les depuis ta bibliothèque. Les ventes et factures restent conservées 10 ans (obligation légale).',
    compte: { id: userId, email: u.email, creeLe: u.createdAt.toISOString() },
    ...data,
  };
}

/**
 * Supprime le compte. Tes morceaux, fichiers, partages, contacts, envois, statistiques et sessions sont effacés.
 * Ce qui reste, pour la loi ou pour d'autres personnes : tes ventes et factures (10 ans), les parts dues à tes
 * collaborateurs et ton compte de reversement Stripe (pour les virements en cours), les achats déjà livrés à tes clients.
 * Dans ce cas, la ligne du compte reste mais sans email ni profil reconnaissables.
 */
export async function deleteAccount(userId: string, confirm: unknown) {
  const [p] = await withUser(userId, (tx) => tx<{ handle: string }[]>`select handle from profiles where user_id = ${userId}`);
  const [u] = await asService((tx) => tx<{ email: string; deletedAt: Date | null }[]>`select email, deleted_at as "deletedAt" from users where id = ${userId}`);
  if (!u || u.deletedAt) throw new NotFound();
  const expected = p?.handle ?? u.email;
  if (z.string().trim().toLowerCase().safeParse(confirm).data !== expected.toLowerCase()) {
    throw new Invalid(`Pour confirmer, tape exactement : ${expected}`);
  }

  // 1. Abonnement en cours : arrêté tout de suite chez Stripe (sinon il serait encore prélevé).
  const [sub] = await asPayments((tx) => tx<{ id: string | null; status: string | null }[]>`
    select subscription_id as id, status from subscriptions where user_id = ${userId}`);
  if (sub?.id && sub.status && !['canceled', 'incomplete_expired'].includes(sub.status)) {
    await stripe().subscriptions.cancel(sub.id, {}, { idempotencyKey: `delete-account-${userId}` });
  }

  // 2. Fichiers à effacer (relevés avant la suppression en base).
  const keys = await asService(async (tx) => {
    const v = await tx<{ k: string | null }[]>`select original_key as k from track_versions where owner_id = ${userId}
      union all select preview_key from track_versions where owner_id = ${userId}
      union all select original_key from imports where owner_id = ${userId}`;
    return v.map((x) => x.k).filter((k): k is string => Boolean(k && k !== 'pending'));
  });

  // 3. Base, en une transaction.
  const outcome = await asService(async (tx) => {
    // Parts sur les morceaux des autres : retirées (sans effet sur les ventes passées, figées).
    await tx`delete from track_splits where collaborator_id = ${userId}`;
    // Tes écoutes chez d'autres producteurs : ton nom disparaît de leurs statistiques (l'écoute reste, anonyme).
    await tx`update listen_sessions set listener_name = null where listener_id = ${userId}`;
    const [{ keep }] = await tx<{ keep: boolean }[]>`select (
      exists (select 1 from orders where seller_id = ${userId}) or exists (select 1 from order_shares where user_id = ${userId})
      or exists (select 1 from stripe_accounts where user_id = ${userId})) as keep`;
    await tx`delete from login_codes where lower(email) = lower(${u.email})`;
    if (!keep) {
      // Rien à garder pour la loi : tout part avec le compte (suppressions en cascade).
      await tx`delete from users where id = ${userId}`;
      return 'deleted' as const;
    }
    // Ventes à garder : on efface tout le reste, puis on rend le compte anonyme.
    const owned = await tx<{ table: string }[]>`select table_name as table from information_schema.columns
      where table_schema = 'public' and column_name = 'owner_id'
      and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE') and table_name not in ('orders', 'order_shares', 'stripe_accounts')`;
    for (const t of owned) await tx`delete from ${tx(t.table)} where owner_id = ${userId}`;
    const refs = await tx<{ table: string; column: string }[]>`select table_name as table, column_name as column from information_schema.columns
      where table_schema = 'public' and column_name in ('listener_id', 'actor_id')
      and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')`;
    for (const r of refs) await tx`update ${tx(r.table)} set ${tx(r.column)} = null where ${tx(r.column)} = ${userId}`;
    await tx`delete from saves where user_id = ${userId}`;
    await tx`delete from sessions where user_id = ${userId}`;
    await tx`delete from subscriptions where user_id = ${userId}`;
    await tx`update orders set buyer_user_id = null where buyer_user_id = ${userId}`;
    const short = userId.replace(/-/g, '').slice(0, 10);
    await tx`update profiles set handle = ${`supprime_${short}`}, display_name = 'Compte supprimé', bio = '', links = '{}'::jsonb, plan = 'free'
      where user_id = ${userId}`;
    await tx`update users set email = ${`supprime+${userId}@sonikc.invalid`}, deleted_at = now() where id = ${userId}`;
    return 'anonymized' as const;
  });

  // 4. Fichiers (après la base : un échec ici laisse des fichiers orphelins, repris par le ménage, jamais l'inverse).
  for (let i = 0; i < keys.length; i += 100) await store().remove(keys.slice(i, i + 100)).catch(() => {});
  return { outcome, filesRemoved: keys.length };
}
