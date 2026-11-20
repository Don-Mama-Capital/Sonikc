import { describe, expect, it } from 'vitest';
import { assertInvoiceReady, COMPANY } from '@/config/company';

describe('Point 5 — mentions légales des factures', () => {
  it('en mode test : factures « document de test » ; en vente réelle : refus tant qu’une mention manque', () => {
    expect(() => assertInvoiceReady(COMPANY, 'sk_test_x')).not.toThrow();
    expect(() => assertInvoiceReady(COMPANY, 'sk_live_x')).toThrow('Clé Stripe réelle');
    expect(() => assertInvoiceReady({ ...COMPANY, testMode: false }, 'sk_test_x')).toThrow('mode test');
    expect(() => assertInvoiceReady({ ...COMPANY, testMode: false }, 'sk_live_x')).toThrow('à compléter');
    expect(() => assertInvoiceReady({ ...COMPANY, testMode: false, legal: 'SAS au capital de 1 000 €, RCS Paris 000 000 000', address: '1 rue X, 75001 Paris', vatNumber: 'FR00000000000' }, 'sk_live_x')).not.toThrow();
  });
});
