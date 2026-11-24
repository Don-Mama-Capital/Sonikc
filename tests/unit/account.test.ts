import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAccount, asService } from '@/lib/server/db';
import { deleteAccount, exportAccount, removePendingFiles } from '@/lib/server/account';
import { signInGoogle } from '@/lib/server/google';
import { createProfile } from '@/lib/server/auth';
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
    const [ls] = await tx<{ id: string }[]>`insert into listen_sessions (owner_id, track_id, listener_id, listener_name, visitor, source)
      values (${other.id}, ${ot.id}, ${u.id}, 'Mon nom', 'v', 'direct') returning id`;
    // Notification d'écoute groupée chez l'autre producteur : nom affiché, séance et clé d'auditeur (sans actor_id).
    await tx`insert into notifications (owner_id, kind, track_id, session_id, actor, listener_keys) values (${other.id}, 'listen', ${ot.id}, ${ls.id}, 'Mon nom', ${[u.id, 'visiteur']})`;
    await tx`insert into notifications (owner_id, kind, track_id, actor, listener_keys) values (${other.id}, 'listen', ${ot.id}, 'Mon nom', ${[u.id]})`;
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
    expect(data.versions).toHaveLength(1);
    for (const k of ['tes_ouvertures_de_liens', 'tes_telechargements_et_favoris', 'membres_des_groupes', 'imports', 'achats', 'certificats']) expect(data[k]).toBeDefined();
    const text = JSON.stringify(data);
    expect(text).not.toContain('"visitor"');
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
    const notes = await asService((tx) => tx<{ actor: string | null; keys: string[] }[]>`select actor, listener_keys as keys from notifications where owner_id = ${r.other.id}`);
    expect(notes).toHaveLength(2);
    for (const n of notes) { expect(n.actor).toBeNull(); expect(n.keys).not.toContain(r.u.id); }
  });

  it('5. suppression avec ventes : ventes, factures et parts gardées ; compte anonyme ; abonnement arrêté', async () => {
    const r = await richUser();
    // Une vente (gardée pour la loi) et un abonnement en cours.
    await asService(async (tx) => {
      await tx`insert into orders (seller_id, track_title, seller_name, licence, exclusive, buyer_email, country, net_cents, vat_rate, vat_cents, gross_cents,
        plan, commission_pct, commission_cents, status, paid_at, invoice_no, delivered_at)
        values (${r.u.id}, 'Mon beat', 'Prod', '{}'::jsonb, false, 'client@x.fr', 'FR', 2900, 20, 580, 3480, 'free', 10, 290, 'paid', now(), ${`FT-${r.u.id.slice(0, 8)}`}, now())`;
      await tx`update users set google_sub = ${`g-${r.u.id}`} where id = ${r.u.id}`;
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
    // Le compte supprimé ne peut plus être supprimé ni exporté.
    await expect(exportAccount(r.u.id)).rejects.toThrow();
    await expect(deleteAccount(r.u.id, 'x')).rejects.toThrow();
    // Se reconnecter avec Google crée un compte neuf : le compte supprimé ne revient pas.
    const again = await signInGoogle({ sub: `g-${r.u.id}`, email: `nouveau${Date.now()}@gmail.com`, name: null });
    expect(again.userId).not.toBe(r.u.id);
    // L'ancien identifiant n'est jamais réattribué (il figure sur les licences émises).
    await expect(createProfile(again.userId, r.u.handle, 'Imposteur')).rejects.toThrow('déjà pris');
    expect(await asService((tx) => tx`select 1 from users where id = ${r.u.id} and google_sub is not null`)).toEqual([]);
  });

  it('5. suppression refusée tant qu’une vente est en cours de paiement ou pas encore livrée', async () => {
    const r = await richUser();
    const insert = (status: string, delivered: boolean) => asService((tx) => tx`insert into orders (seller_id, track_id, track_title, seller_name, licence, exclusive,
      buyer_email, country, net_cents, vat_rate, vat_cents, gross_cents, plan, commission_pct, commission_cents, status, paid_at, invoice_no, delivered_at)
      values (${r.u.id}, ${r.trackId}, 'Mon beat', 'Prod', '{}'::jsonb, false, 'client@x.fr', 'FR', 2900, 20, 580, 3480, 'free', 10, 290, ${status},
        ${status === 'paid' ? new Date() : null}, ${status === 'paid' ? `FT-p${Date.now()}` : null}, ${delivered ? new Date() : null}) returning id`);
    const [pending] = await insert('pending', false);
    await expect(deleteAccount(r.u.id, r.u.handle)).rejects.toThrow('est en cours');
    await asService((tx) => tx`update orders set status = 'expired' where id = ${pending.id}`);
    await insert('paid', false);
    await expect(deleteAccount(r.u.id, r.u.handle)).rejects.toThrow('est en cours');
    expect(await exists(r.key)).toBe(true);
    expect(await asService((tx) => tx`select 1 from sessions where user_id = ${r.u.id}`)).toHaveLength(1);
  });

  it('5. suppression refusée tant que de l’argent de ventes t’est dû sans compte de reversement (montant donné)', async () => {
    const r = await richUser();
    const seller = await makeUser();
    await asService(async (tx) => {
      const [o] = await tx<{ id: string }[]>`insert into orders (seller_id, track_title, seller_name, licence, exclusive, buyer_email, country, net_cents, vat_rate,
        vat_cents, gross_cents, plan, commission_pct, commission_cents, status, paid_at, invoice_no, delivered_at)
        values (${seller.id}, 'Beat', 'Prod', '{}'::jsonb, false, 'client@x.fr', 'FR', 2900, 20, 580, 3480, 'free', 10, 290, 'paid', now(), ${`FT-o${Date.now()}`}, now())
        returning id`;
      await tx`insert into order_shares (order_id, user_id, is_owner, pct, amount_cents, status) values (${o.id}, ${r.u.id}, false, 20, 512, 'held')`;
    });
    await expect(deleteAccount(r.u.id, r.u.handle)).rejects.toThrow('Il te reste 5,12');
    expect(await exists(r.key)).toBe(true);
    // Renoncer à un montant plus petit que celui dû (vente arrivée entre-temps) : toujours refusé.
    await expect(deleteAccount(r.u.id, r.u.handle, { renounceCents: 500 })).rejects.toThrow('Il te reste 5,12');
    // Renoncer au montant affiché : la suppression passe (compte anonymisé, renonciation datée, la part sort des virements).
    expect((await deleteAccount(r.u.id, r.u.handle, { renounceCents: 512 })).outcome).toBe('anonymized');
    const [u] = await asService((tx) => tx<{ at: Date | null }[]>`select shares_renounced_at as at from users where id = ${r.u.id}`);
    expect(u.at).not.toBeNull();
    const [sh] = await asService((tx) => tx<{ retry: string }[]>`select retry_at::text as retry from order_shares where user_id = ${r.u.id}`);
    expect(sh.retry).toBe('infinity');
    expect(await exists(r.key)).toBe(false);
  });

  it('5. une part bloquée par un litige ou une vente en cours de remboursement ne bloque pas la suppression', async () => {
    const r = await richUser();
    const seller = await makeUser();
    await asService(async (tx) => {
      const mk = async (refund: boolean) => (await tx<{ id: string }[]>`insert into orders (seller_id, track_title, seller_name, licence, exclusive, buyer_email,
        country, net_cents, vat_rate, vat_cents, gross_cents, plan, commission_pct, commission_cents, status, paid_at, invoice_no, delivered_at, refund_requested_at)
        values (${seller.id}, 'Beat', 'Prod', '{}'::jsonb, false, 'c@x.fr', 'FR', 2900, 20, 580, 3480, 'free', 10, 290, 'paid', now(),
          ${`FT-r${Date.now()}${refund}`}, now(), ${refund ? new Date() : null}) returning id`)[0].id;
      await tx`insert into order_shares (order_id, user_id, is_owner, pct, amount_cents, status) values (${await mk(false)}, ${r.u.id}, false, 20, 300, 'disputed')`;
      await tx`insert into order_shares (order_id, user_id, is_owner, pct, amount_cents, status) values (${await mk(true)}, ${r.u.id}, false, 20, 300, 'held')`;
    });
    expect((await deleteAccount(r.u.id, r.u.handle, { renounceCents: 99_999 })).outcome).toBe('anonymized');
    // Rien n'était dû : aucune renonciation notée.
    expect((await asService((tx) => tx<{ at: Date | null }[]>`select shares_renounced_at as at from users where id = ${r.u.id}`))[0].at).toBeNull();
  });

  it('suppression : les invitations où tu es collaborateur partent aussi', async () => {
    const r = await richUser();
    const owner = await makeUser();
    await asService(async (tx) => {
      const [t] = await tx<{ id: string }[]>`insert into tracks (owner_id, title) values (${owner.id}, 'X') returning id`;
      await tx`insert into track_splits (track_id, owner_id, collaborator_id, pct) values (${t.id}, ${owner.id}, ${r.u.id}, 10)`;
      await tx`insert into split_invite_log (owner_id, collaborator_id) values (${owner.id}, ${r.u.id})`;
      await tx`insert into orders (seller_id, track_title, seller_name, licence, exclusive, buyer_email, country, net_cents, vat_rate, vat_cents, gross_cents,
        plan, commission_pct, commission_cents, status, paid_at, invoice_no, delivered_at) values (${r.u.id}, 'B', 'P', '{}'::jsonb, false, 'c@x.fr', 'FR',
        100, 20, 20, 120, 'free', 10, 10, 'paid', now(), ${`FT-i${Date.now()}`}, now())`;
    });
    const cols = await asService((tx) => tx<{ t: string }[]>`select table_name as t from information_schema.columns where table_schema = 'public' and column_name = 'collaborator_id'`);
    expect((await deleteAccount(r.u.id, r.u.handle)).outcome).toBe('anonymized');
    for (const { t } of cols) expect(await asService((tx) => tx`select 1 from ${tx(t)} where collaborator_id = ${r.u.id}`), t).toEqual([]);
  });

  it('accès « compte » : il ne voit que les lignes du compte concerné', async () => {
    const a = await richUser();
    const b = await richUser();
    expect(await asAccount(a.u.id, (tx) => tx`select id from tracks where owner_id = ${b.u.id}`)).toEqual([]);
    expect(await asAccount(a.u.id, (tx) => tx`select id from users where id = ${b.u.id}`)).toEqual([]);
    expect(await asAccount(a.u.id, (tx) => tx`select 1 from sessions where user_id = ${b.u.id}`)).toEqual([]);
    expect(await asAccount(a.u.id, (tx) => tx`select id from tracks where owner_id = ${a.u.id}`)).toHaveLength(1);
    // Lecture seule : aucune écriture directe, même sur ses propres lignes ou celles où il apparaît chez d'autres.
    for (const q of ['delete from contacts', 'update listen_sessions set listened_ms = 0', 'delete from notifications', 'update orders set buyer_user_id = null',
      'update orders set net_cents = 1', 'delete from orders', "update profiles set plan = 'studio'", "update users set email = 'x@y.z'",
      "insert into retired_handles (handle) values ('quelquun')", 'select app.detach_account()']) {
      await expect(asAccount(a.u.id, (tx) => tx.unsafe(q)), q).rejects.toThrow(/permission denied/);
    }
    // File des fichiers : seulement ses propres fichiers.
    await expect(asAccount(a.u.id, (tx) => tx`insert into pending_file_removals (key) values (${`u/${b.u.id}/t/x/original.wav`})`))
      .rejects.toThrow(/row-level security/);
    await expect(asAccount(a.u.id, (tx) => tx`insert into pending_file_removals (key) values (${`u/${a.u.id}/t/x/original.wav`})`)).resolves.toBeTruthy();
    // Toute table reliée à un compte est couverte par une règle de lecture du compte (une table oubliée se verrait ici).
    const missing = await asService((tx) => tx<{ t: string }[]>`select distinct c.table_name as t from information_schema.columns c
      join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.column_name in ('owner_id', 'user_id', 'listener_id', 'actor_id', 'collaborator_id')
        and not exists (select 1 from pg_policies p where p.tablename = c.table_name and 'sonikc_account' = any(p.roles) and p.cmd in ('SELECT', 'ALL'))`);
    expect(missing).toEqual([]);
    // Sans compte : rien d'autre que la file des fichiers à effacer.
    expect(await asAccount(null, (tx) => tx`select id from tracks`)).toEqual([]);
    // Plus aucun accès complet dans le code des comptes.
    const { readFile } = await import('node:fs/promises');
    expect(await readFile('src/lib/server/account.ts', 'utf8')).not.toMatch(/asService/);
  });

  it('fichiers : un effacement qui échoue est noté puis repris', async () => {
    await asService((tx) => tx`insert into pending_file_removals (key) values ('u/absent/x.wav') on conflict do nothing`);
    const key = `u/test/${Date.now()}.wav`;
    await store().put(key, Buffer.from('x'), 10);
    await asService((tx) => tx`insert into pending_file_removals (key) values (${key})`);
    expect(await removePendingFiles()).toBeGreaterThanOrEqual(2);
    expect(await exists(key)).toBe(false);
    expect(await asService((tx) => tx`select 1 from pending_file_removals where key = ${key}`)).toEqual([]);
  });

  it('rétractation : l’achat exige la renonciation expresse, horodatée sur la commande', async () => {
    const u = await makeUser();
    await expect(startCheckout({ trackId: u.id, templateId: u.id, country: 'FR', email: 'a@b.fr' }, { buyerUserId: null, ip: '1.2.3.4' }))
      .rejects.toThrow('Coche la case');
  });
});
