import { describe, expect, it } from 'vitest';
import { assertInvoiceReady, COMPANY } from '@/config/company';

describe('Point 5 — mentions légales des factures', () => {
  it('en mode test : factures « document de test » ; en vente réelle : refus tant qu’une mention manque', () => {
    expect(() => assertInvoiceReady(COMPANY)).not.toThrow();
    expect(() => assertInvoiceReady({ ...COMPANY, testMode: false })).toThrow('à compléter');
    expect(() => assertInvoiceReady({ ...COMPANY, testMode: false, legal: 'SAS au capital de 1 000 €, RCS Paris 000 000 000', address: '1 rue X, 75001 Paris', vatNumber: 'FR00000000000' })).not.toThrow();
  });
});
