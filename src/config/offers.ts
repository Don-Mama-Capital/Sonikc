/**
 * Fichier unique des offres de Sonikc. La phase 5 y ajoute prix, limites et avantages ;
 * la phase 4 n'utilise que la commission prélevée sur les ventes.
 * Commission choisie le 20/11/2026 : 10 % sur l'offre gratuite (Sonikc encaisse, facture et gère la TVA),
 * 0 % sur les offres payantes, comme les grandes plateformes de beats. À confirmer avec les prix en phase 5.
 */
export const OFFERS = {
  free: { name: 'Gratuit', commissionPct: 10 },
  pro: { name: 'Pro', commissionPct: 0 },
  studio: { name: 'Studio', commissionPct: 0 },
} as const;

export type OfferId = keyof typeof OFFERS;
export const offerIds = Object.keys(OFFERS) as OfferId[];
export const commissionPct = (plan: string) => (OFFERS as Record<string, { commissionPct: number }>)[plan]?.commissionPct ?? OFFERS.free.commissionPct;
