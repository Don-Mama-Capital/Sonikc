/**
 * Fichier unique des offres de Sonikc : noms, prix, essai, commission, limites et leurs libellés.
 * La page tarifs, le comparatif, les contrôles côté serveur et la commission en découlent ; aucun texte d'offre
 * n'est écrit ailleurs (un test le vérifie). Chaque avantage annoncé correspond à une limite contrôlée : rien de « bientôt ».
 *
 * Commission choisie le 20/11/2026 : 10 % sur l'offre gratuite (Sonikc encaisse, facture et gère la TVA),
 * 0 % sur les offres payantes, comme les grandes plateformes de beats. À savoir : à 0 %, les frais Stripe d'un
 * remboursement ou d'un litige sont une perte sèche pour Sonikc (l'abonnement la couvre).
 * Prix et limites optimisés le 24/11/2026 (demande du propriétaire) : prix alignés sur le marché des plateformes de beats
 * (~9 et ~19 par mois), annuel = 10 mois ; stockage plafonné pour rester rentable même à pleine utilisation
 * (stockage fichiers ~0,02 $/Go/mois chez l'hébergeur : 100 Go ≈ 2 €, 500 Go ≈ 10 € par mois).
 */

export type Limits = {
  /** Morceaux dans la bibliothèque (hors corbeille). null = illimité. */
  tracks: number | null;
  /** Espace de stockage des fichiers audio, en Go. */
  storageGb: number;
  /** Mot de passe sur un partage. */
  passwordLinks: boolean;
  /** Profondeur de l'historique des statistiques d'écoute, en jours. null = tout l'historique. */
  statsDays: number | null;
  /** Contacts. */
  contacts: number;
  /** Emails envoyés par mois (envois groupés et relances). */
  emailsPerMonth: number;
  /** Programmer un envoi plus tard. */
  scheduledSends: boolean;
  /** Relance automatique de ceux qui n'ont pas écouté. */
  followUps: boolean;
};

export type Offer = {
  name: string;
  tagline: string;
  /** Prix TTC en centimes ; 0 = gratuit. */
  priceMonthCents: number;
  priceYearCents: number;
  /** Jours d'essai gratuit (une seule fois par compte). */
  trialDays: number;
  /** Commission sur le prix HT des ventes de licences. */
  commissionPct: number;
  limits: Limits;
};

export const OFFERS = {
  free: {
    name: 'Gratuit',
    tagline: 'Pour ranger, partager et suivre tes premiers beats.',
    priceMonthCents: 0, priceYearCents: 0, trialDays: 0, commissionPct: 10,
    limits: { tracks: 25, storageGb: 2, passwordLinks: false, statsDays: 30, contacts: 100, emailsPerMonth: 50, scheduledSends: false, followUps: false },
  },
  pro: {
    name: 'Pro',
    tagline: 'Pour envoyer à grande échelle et vendre sans commission.',
    priceMonthCents: 900, priceYearCents: 9000, trialDays: 14, commissionPct: 0,
    limits: { tracks: null, storageGb: 100, passwordLinks: true, statsDays: null, contacts: 5000, emailsPerMonth: 2000, scheduledSends: true, followUps: false },
  },
  studio: {
    name: 'Studio',
    tagline: 'Pour les gros catalogues et les relances automatiques.',
    priceMonthCents: 1900, priceYearCents: 19000, trialDays: 14, commissionPct: 0,
    limits: { tracks: null, storageGb: 500, passwordLinks: true, statsDays: null, contacts: 20000, emailsPerMonth: 10000, scheduledSends: true, followUps: true },
  },
} as const satisfies Record<string, Offer>;

export type OfferId = keyof typeof OFFERS;
export const offerIds = Object.keys(OFFERS) as OfferId[];
export const FREE: OfferId = 'free';
export const isOfferId = (x: unknown): x is OfferId => typeof x === 'string' && Object.hasOwn(OFFERS, x);
export const offerOf = (plan: string): Offer => (isOfferId(plan) ? OFFERS[plan] : OFFERS[FREE]);
export const commissionPct = (plan: string) => offerOf(plan).commissionPct;
export const limitsOf = (plan: string): Limits => offerOf(plan).limits;

const n = (x: number) => x.toLocaleString('fr-FR');

/** Libellé lisible de chaque limite (page tarifs, comparatif, messages de limite atteinte). */
export const LIMIT_LABELS: { [K in keyof Limits]: { title: string; value: (v: Limits[K]) => string } } = {
  tracks: { title: 'Morceaux', value: (v) => (v === null ? 'Illimités' : n(v)) },
  storageGb: { title: 'Stockage', value: (v) => (v >= 1000 ? `${n(v / 1000)} To` : `${n(v)} Go`) },
  passwordLinks: { title: 'Partages protégés par mot de passe', value: (v) => (v ? 'Oui' : 'Non') },
  statsDays: { title: 'Historique des écoutes', value: (v) => (v === null ? 'Complet' : `${n(v)} derniers jours`) },
  contacts: { title: 'Contacts', value: (v) => n(v) },
  emailsPerMonth: { title: 'Emails par mois', value: (v) => n(v) },
  scheduledSends: { title: 'Envois programmés', value: (v) => (v ? 'Oui' : 'Non') },
  followUps: { title: 'Relances automatiques', value: (v) => (v ? 'Oui' : 'Non') },
};

/** Ce qui est inclus partout (aucune limite) : affiché tel quel sur la page tarifs. */
export const INCLUDED_EVERYWHERE = [
  'Partage par lien, sur invitation ou public',
  'Qui écoute, combien de temps, depuis quel lien',
  'Page publique et vente de licences',
  'Parts des collaborateurs et certificat de licence',
];

export const commissionLabel = (pct: number) => (pct === 0 ? 'Aucune commission sur tes ventes' : `${n(pct)} % de commission sur tes ventes`);

export const euros = (cents: number) => (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: cents % 100 ? 2 : 0 });

/** La plus petite offre qui lève une limite donnée (pour le message « passe à … »). */
export function upgradeFor<K extends keyof Limits>(key: K, need?: number): OfferId | null {
  for (const id of offerIds) {
    const v = OFFERS[id].limits[key] as Limits[K];
    if (typeof v === 'boolean' ? v : v === null || (need !== undefined && (v as number) >= need)) return id;
  }
  return null;
}
