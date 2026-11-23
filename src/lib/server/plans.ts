import type { Tx } from './db';
import { Invalid } from './library';
import { LIMIT_LABELS, OFFERS, limitsOf, offerOf, upgradeFor, type Limits, type OfferId } from '@/config/offers';

/** Lot 5.1 : contrôle côté serveur de chaque limite du fichier des offres. */

export class LimitReached extends Invalid {
  constructor(message: string, readonly limit: keyof Limits) { super(message); }
}

/** Offre en vigueur d'un utilisateur (fixée par l'abonnement, lot 5.2). */
export async function planOf(tx: Tx, userId: string): Promise<OfferId> {
  const [p] = await tx<{ plan: string }[]>`select plan from profiles where user_id = ${userId}`;
  return (p?.plan ?? 'free') as OfferId;
}

export async function limitsFor(tx: Tx, userId: string) {
  const plan = await planOf(tx, userId);
  return { plan, limits: limitsOf(plan) };
}

/** Message clair, entièrement tiré du fichier des offres. */
export function limitMessage<K extends keyof Limits>(plan: string, key: K, need?: number) {
  const offer = offerOf(plan);
  const label = LIMIT_LABELS[key];
  const current = label.value(offer.limits[key] as never);
  const up = upgradeFor(key, need);
  const next = up && up !== plan ? ` Passe à l’offre ${OFFERS[up].name} pour aller plus loin (voir /tarifs).` : '';
  return `Limite de ton offre ${offer.name} — ${label.title} : ${current}.${next}`;
}

export function fail<K extends keyof Limits>(plan: string, key: K, need?: number): never {
  throw new LimitReached(limitMessage(plan, key, need), key);
}

/** Espace utilisé (octets) : versions enregistrées + envois en cours déclarés. */
export async function storageUsed(tx: Tx, userId: string) {
  const [{ used }] = await tx<{ used: string }[]>`select coalesce(sum(size_bytes), 0)::bigint as used from track_versions where owner_id = ${userId}`;
  return Number(used);
}

export const GB = 1_000_000_000;

/** Emails comptés ce mois-ci (envois groupés et relances, hors ignorés et échecs). */
export async function emailsThisMonth(tx: Tx, userId: string) {
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from email_sends
    where owner_id = ${userId} and status not in ('skipped', 'failed')
      and coalesce(sent_at, next_attempt_at) >= date_trunc('month', now())`;
  return n;
}
