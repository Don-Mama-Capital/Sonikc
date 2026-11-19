/**
 * Fichier unique des offres de Sonikc. La phase 5 y ajoute prix, limites et avantages ;
 * la phase 4 n'utilise que la commission prélevée sur les ventes.
 * ⚠ Taux provisoires, à valider par le propriétaire du projet.
 */
export const OFFERS = {
  free: { name: 'Gratuit', commissionPct: 10 },
  pro: { name: 'Pro', commissionPct: 5 },
  studio: { name: 'Studio', commissionPct: 0 },
} as const;

export type OfferId = keyof typeof OFFERS;
export const offerIds = Object.keys(OFFERS) as OfferId[];
export const commissionPct = (plan: string) => (OFFERS as Record<string, { commissionPct: number }>)[plan]?.commissionPct ?? OFFERS.free.commissionPct;
