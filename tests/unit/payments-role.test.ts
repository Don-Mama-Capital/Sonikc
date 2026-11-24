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
    // Un morceau sans vente ni collaborateur n'est même pas visible ; avec un collaborateur, seule l'exclusivité s'écrit.
    expect((await asPayments((tx) => tx`update tracks set exclusive_reserved_until = now() where id = ${t.id}`)).count).toBe(0);
    const collab = await makeUser();
    await asService((tx) => tx`insert into track_splits (track_id, owner_id, collaborator_id, pct) values (${t.id}, ${u.id}, ${collab.id}, 10)`);
    const r = await asPayments((tx) => tx`update tracks set exclusive_reserved_until = now() where id = ${t.id}`);
    expect(r.count).toBe(1);
    // Ce dont la vente a besoin reste permis.
    const [me] = await asPayments((tx) => tx<{ email: string }[]>`select email from users where id = ${u.id}`);
    expect(me.email).toBe(u.email);
  });

  it('2 bis. aucune lecture des bibliothèques privées : ni projets, ni versions non vendues, ni colonnes sensibles', async () => {
    const u = await makeUser();
    const ids = await asService(async (tx) => {
      const [t] = await tx<{ id: string }[]>`insert into tracks (owner_id, title, password_hash) values (${u.id}, 'Secret', 'hash') returning id`;
      const [v] = await tx<{ id: string }[]>`insert into track_versions (track_id, owner_id, version_no, label, original_filename, original_key)
        values (${t.id}, ${u.id}, 1, 'v1', 'a.wav', ${`u/${u.id}/secret.wav`}) returning id`;
      return { t: t.id, v: v.id };
    });
    for (const q of ['select * from projects', 'select * from project_tracks', 'select password_hash from tracks', 'select visibility from tracks',
      'select preview_key from track_versions', 'select original_filename from track_versions', 'select bio from profiles', 'select links from profiles']) {
      await expect(asPayments((tx) => tx.unsafe(q)), q).rejects.toThrow(/permission denied/);
    }
    expect(await asPayments((tx) => tx`select title from tracks where id = ${ids.t}`)).toEqual([]);
    expect(await asPayments((tx) => tx`select original_key from track_versions where id = ${ids.v}`)).toEqual([]);
    // L'app ne peut pas se donner une offre payante en créant son profil.
    const { withUser } = await import('@/lib/server/db');
    const fresh = await asService((tx) => tx<{ id: string }[]>`insert into users (email) values (${`p${Date.now()}@test.local`}) returning id`);
    await expect(withUser(fresh[0].id, (tx) => tx`insert into profiles (user_id, handle, display_name, plan) values (${fresh[0].id}, ${`h${Date.now()}`}, 'X', 'studio')`))
      .rejects.toThrow(/permission denied/);
  });
});
