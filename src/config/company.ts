/**
 * Émetteur des factures (Sonikc vend au nom des producteurs : il est le fournisseur au sens de la TVA).
 * ⚠ À compléter avec les informations légales réelles avant toute vente réelle (validation juridique et comptable).
 */
export const COMPANY = {
  name: 'Sonikc',
  legal: 'Mentions légales à compléter (forme, capital, RCS)',
  address: 'Adresse à compléter',
  vatNumber: 'N° de TVA à compléter',
  testMode: true,
};

/** Avant toute vente réelle : refuse de facturer tant qu'une mention légale reste « à compléter ». */
export function assertInvoiceReady(c: typeof COMPANY = COMPANY) {
  if (c.testMode) return;
  const missing = [c.legal, c.address, c.vatNumber].some((v) => /compléter/i.test(v));
  if (missing) throw new Error('Mentions légales des factures à compléter avant la vente réelle (src/config/company.ts).');
}
