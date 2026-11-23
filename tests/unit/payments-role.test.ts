import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { asPayments, asService } from '@/lib/server/db';
import { makeUser } from './helpers';

/** Lot 5.0 : le code de paiement n'a que les droits dont il a besoin (rôle sonikc_payments). */
describe('Lot 5.0 — accès dédié aux paiements', () => {
  it('1. les modules de paiement n’utilisent plus l’accès complet', async () => {
    for (const f of ['src/lib/server/commerce.ts', 'src/lib/server/order-delivery.ts']) {
      const src = await readFile(f, 'utf8');
      expect(src).not.toMatch(/\basService\b/);
      expect(src).toMatch(/\basPayments\(/);
    }
  });

  it('2. hors des tables de vente, la base refuse : bibliothèques, contacts, campagnes, liens, écoutes, sessions, codes', async () => {
    const u = await makeUser();
    const [t] = await asService((tx) => tx<{ id: string }[]>`insert into tracks (owner_id, title) values (${u.id}, 'Privé') returning id`);
    const denied = [
      'select * from contacts', 'select * from contact_groups', 'select * from campaigns', 'select * from email_sends',
      'select * from email_suppressions', 'select * from share_links', 'select * from invites', 'select * from listen_sessions',
      'select * from link_views', 'select * from interactions', 'select * from saves', 'select * from notifications',
      'select * from sessions', 'select * from login_codes', 'select * from folders', 'select * from imports', 'select * from unlock_attempts',
      'select created_at from users', 'delete from orders', 'delete from order_shares', 'delete from tracks',
      'update profiles set bio = \'x\'', 'insert into tracks (owner_id, title) values (gen_random_uuid(), \'x\')',
      'update jobs set status = \'done\'', 'delete from licence_certificates',
    ];
    for (const q of denied) {
      await expect(asPayments((tx) => tx.unsafe(q)), q).rejects.toThrow(/permission denied/);
    }
    // Morceaux : seulement les colonnes d'exclusivité.
    await expect(asPayments((tx) => tx`update tracks set title = 'piraté' where id = ${t.id}`)).rejects.toThrow(/permission denied/);
    await expect(asPayments((tx) => tx`update tracks set deleted_at = now() where id = ${t.id}`)).rejects.toThrow(/permission denied/);
    await expect(asPayments((tx) => tx`update tracks set visibility = 'public' where id = ${t.id}`)).rejects.toThrow(/permission denied/);
    const r = await asPayments((tx) => tx`update tracks set exclusive_reserved_until = now() where id = ${t.id}`);
    expect(r.count).toBe(1);
    // Ce dont la vente a besoin reste permis.
    const [me] = await asPayments((tx) => tx<{ email: string }[]>`select email from users where id = ${u.id}`);
    expect(me.email).toBe(u.email);
  });
});
