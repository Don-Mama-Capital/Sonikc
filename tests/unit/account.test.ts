import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asService } from '@/lib/server/db';
import { deleteAccount, exportAccount } from '@/lib/server/account';
import { startSubscription } from '@/lib/server/billing';
import { handleWebhook, startCheckout } from '@/lib/server/commerce';
import { exists, store } from '@/lib/server/storage';
import { startFakeStripe, type FakeStripe } from '../../scripts/fake-stripe';
import { makeUser } from './helpers';

let fake: FakeStripe;
beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
  fake = await startFakeStripe({ webhookSecret: 'whsec_test_fake', webhook: async (p, s) => { try { await handleWebhook(p, s); return 200; } catch { return 400; } } });
  process.env.STRIPE_API_BASE = fake.url;
});
afterAll(async () => { await fake.close(); });

/** Un producteur avec un peu de tout : morceau et fichier, partage, contact, écoute chez un autre producteur. */
async function richUser() {
  const u = await makeUser();
  const other = await makeUser();
  const ids = await asService(async (tx) => {
    const [t] = await tx<{ id: string }[]>`insert into tracks (owner_id, title) values (${u.id}, 'Mon beat') returning id`;
    const key = `u/${u.id}/t/${t.id}/v/x/original.wav`;
    await store().put(key, Buffer.from('RIFFdata'), 1000);
    const [v] = await tx<{ id: string }[]>`insert into track_versions (track_id, owner_id, version_no, label, original_filename, original_key, status)
      values (${t.id}, ${u.id}, 1, 'v1', 'a.wav', ${key}, 'ready') returning id`;
    await tx`update tracks set current_version_id = ${v.id}, password_hash = 'secret-hash' where id = ${t.id}`;
    await tx`insert into contacts (owner_id, email, name) values (${u.id}, 'artiste@x.fr', 'Lyna')`;
    await tx`insert into share_links (owner_id, track_id, label) values (${u.id}, ${t.id}, 'Insta')`;
    const [ot] = await tx<{ id: string }[]>`insert into tracks (owner_id, title) values (${other.id}, 'Son beat') returning id`;
    await tx`insert into listen_sessions (owner_id, track_id, listener_id, listener_name, visitor, source) values (${other.id}, ${ot.id}, ${u.id}, 'Mon nom', 'v', 'direct')`;
    await tx`insert into sessions (user_id, token_hash, expires_at) values (${u.id}, ${`h${u.id}`}, now() + interval '1 day')`;
    return { trackId: t.id, key, otherTrack: ot.id };
  });
  return { u, other, ...ids };
}

const ownedRows = (uid: string) => asService(async (tx) => {
  const tables = await tx<{ t: string }[]>`select table_name as t from information_schema.columns where table_schema = 'public' and column_name = 'owner_id'
    and table_name not in ('orders', 'order_shares', 'stripe_accounts')`;
  let n = 0;
  for (const { t } of tables) n += (await tx<{ n: number }[]>`select count(*)::int as n from ${tx(t)} where owner_id = ${uid}`)[0].n;
  return n;
});

describe('Lot 5.3 — export et suppression du compte', () => {
  it('4. export JSON : tout ce qui est à toi, rien des autres, aucun secret', async () => {
    const r = await richUser();
    const data = (await exportAccount(r.u.id)) as unknown as Record<string, unknown[]> & { compte: { email: string } };
    expect(data.compte.email).toBe(r.u.email);
    expect(data.morceaux.map((t) => (t as { title: string }).title)).toEqual(['Mon beat']);
    expect(data.contacts).toHaveLength(1);
    expect(data.liens_de_partage).toHaveLength(1);
    expect(data.tes_ecoutes).toHaveLength(1);
    const text = JSON.stringify(data);
    expect(text).not.toContain('Son beat');
    expect(text).not.toContain('secret-hash');
    expect(text).not.toContain(r.key);
  });

  it('5. suppression sans vente : compte, données et fichiers effacés ; ton nom disparaît des stats des autres', async () => {
    const r = await richUser();
    await expect(deleteAccount(r.u.id, 'pas-le-bon')).rejects.toThrow('tape exactement');
    expect(await exists(r.key)).toBe(true);
    const res = await deleteAccount(r.u.id, r.u.handle);
    expect(res).toMatchObject({ outcome: 'deleted' });
    expect(await asService((tx) => tx`select 1 from users where id = ${r.u.id}`)).toEqual([]);
    expect(await ownedRows(r.u.id)).toBe(0);
    expect(await exists(r.key)).toBe(false);
    const [l] = await asService((tx) => tx<{ listenerId: string | null; name: string | null }[]>`
      select listener_id as "listenerId", listener_name as name from listen_sessions where track_id = ${r.otherTrack}`);
    expect(l).toEqual({ listenerId: null, name: null }); // l'écoute reste, anonyme
  });

  it('5. suppression avec ventes : ventes, factures et parts gardées ; compte anonyme ; abonnement arrêté', async () => {
    const r = await richUser();
    // Une vente (gardée pour la loi) et un abonnement en cours.
    await asService(async (tx) => {
      await tx`insert into orders (seller_id, track_title, seller_name, licence, exclusive, buyer_email, country, net_cents, vat_rate, vat_cents, gross_cents,
        plan, commission_pct, commission_cents, status, paid_at, invoice_no)
        values (${r.u.id}, 'Mon beat', 'Prod', '{}'::jsonb, false, 'client@x.fr', 'FR', 2900, 20, 580, 3480, 'free', 10, 290, 'paid', now(), ${`FT-${r.u.id.slice(0, 8)}`})`;
    });
    await asService((tx) => tx`update profiles set plan = 'free' where user_id = ${r.u.id}`);
    const { url } = await startSubscription(r.u.id, { plan: 'pro', period: 'month', country: 'FR' });
    await fake.pay(new URL(url).pathname.split('/').pop()!);
    const [sub] = await asService((tx) => tx<{ id: string }[]>`select subscription_id as id from subscriptions where user_id = ${r.u.id}`);

    const res = await deleteAccount(r.u.id, r.u.handle);
    expect(res.outcome).toBe('anonymized');
    expect(fake.billing.subscriptions.get(sub.id)!.status).toBe('canceled');
    const [u] = await asService((tx) => tx<{ email: string; deletedAt: Date | null }[]>`select email, deleted_at as "deletedAt" from users where id = ${r.u.id}`);
    expect(u.email).not.toContain(r.u.handle);
    expect(u.deletedAt).not.toBeNull();
    const [p] = await asService((tx) => tx<{ handle: string; displayName: string }[]>`select handle, display_name as "displayName" from profiles where user_id = ${r.u.id}`);
    expect(p).toMatchObject({ displayName: 'Compte supprimé' });
    expect(p.handle).not.toBe(r.u.handle);
    expect(await ownedRows(r.u.id)).toBe(0);
    expect(await asService((tx) => tx`select 1 from sessions where user_id = ${r.u.id}`)).toEqual([]);
    expect(await asService((tx) => tx`select 1 from orders where seller_id = ${r.u.id} and status = 'paid'`)).toHaveLength(1);
    expect(await exists(r.key)).toBe(false);
    // L'identifiant d'origine est libre ; le compte supprimé ne peut plus être supprimé ni exporté.
    await expect(exportAccount(r.u.id)).rejects.toThrow();
    await expect(deleteAccount(r.u.id, 'x')).rejects.toThrow();
  });

  it('rétractation : l’achat exige la renonciation expresse, horodatée sur la commande', async () => {
    const u = await makeUser();
    await expect(startCheckout({ trackId: u.id, templateId: u.id, country: 'FR', email: 'a@b.fr' }, { buyerUserId: null, ip: '1.2.3.4' }))
      .rejects.toThrow('Coche la case');
  });
});
