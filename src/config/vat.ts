/**
 * Taux normaux de TVA de l'UE (services électroniques vendus à des particuliers : taux du pays de l'acheteur).
 * Source : liste Taxually vérifiée contre la liste de la Commission européenne (dernière vérification : 13 juillet 2026).
 * Seul endroit où ces taux existent dans le code. À relire avec le comptable avant toute vente réelle.
 */
export const EU_VAT: Record<string, { name: string; rate: number }> = {
  AT: { name: 'Autriche', rate: 20 }, BE: { name: 'Belgique', rate: 21 }, BG: { name: 'Bulgarie', rate: 20 },
  HR: { name: 'Croatie', rate: 25 }, CY: { name: 'Chypre', rate: 19 }, CZ: { name: 'Tchéquie', rate: 21 },
  DK: { name: 'Danemark', rate: 25 }, EE: { name: 'Estonie', rate: 24 }, FI: { name: 'Finlande', rate: 25.5 },
  FR: { name: 'France', rate: 20 }, DE: { name: 'Allemagne', rate: 19 }, GR: { name: 'Grèce', rate: 24 },
  HU: { name: 'Hongrie', rate: 27 }, IE: { name: 'Irlande', rate: 23 }, IT: { name: 'Italie', rate: 22 },
  LV: { name: 'Lettonie', rate: 21 }, LT: { name: 'Lituanie', rate: 21 }, LU: { name: 'Luxembourg', rate: 17 },
  MT: { name: 'Malte', rate: 18 }, NL: { name: 'Pays-Bas', rate: 21 }, PL: { name: 'Pologne', rate: 23 },
  PT: { name: 'Portugal', rate: 23 }, RO: { name: 'Roumanie', rate: 21 }, SK: { name: 'Slovaquie', rate: 23 },
  SI: { name: 'Slovénie', rate: 22 }, ES: { name: 'Espagne', rate: 21 }, SE: { name: 'Suède', rate: 25 },
};

/** Hors UE : pas de TVA européenne (règle à confirmer par le comptable pour chaque pays). */
export const OUTSIDE_EU = 'XX';

export const COUNTRIES = [
  ...Object.entries(EU_VAT).map(([code, v]) => ({ code, name: v.name })).sort((a, b) => a.name.localeCompare(b.name, 'fr')),
  { code: OUTSIDE_EU, name: 'Autre pays (hors Union européenne)' },
];

export const vatRate = (country: string) => EU_VAT[country]?.rate ?? 0;

/** Montant TTC et TVA à partir d'un prix HT en centimes (arrondi au centime le plus proche). */
export function withVat(netCents: number, country: string) {
  const vat = Math.round((netCents * vatRate(country)) / 100);
  return { net: netCents, vat, gross: netCents + vat, rate: vatRate(country) };
}
