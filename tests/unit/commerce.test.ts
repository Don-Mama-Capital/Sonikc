import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asService, withUser } from '@/lib/server/db';
import { updateShareSettings } from '@/lib/server/sharing';
import { listTemplates } from '@/lib/server/storefront';
import { store } from '@/lib/server/storage';
import { sha256 } from '@/lib/server/crypto';
import {
  commissionCents, computeShares, confirmPayment, handleWebhook, listPurchases, listSales, orderFile, orderView, parseOrderToken,
  refreshAccount, refundByPlatform, refundBySeller, respondSplit, listSplits, listSplitInvites, withdrawSplit, runTransfers, setSplits, startCheckout, startOnboarding, sweepPayments,
} from '@/lib/server/commerce';
import { OFFERS } from '@/config/offers';
import { startFakeStripe, type FakeStripe } from '../../scripts/fake-stripe';
import { drain } from '../../worker/index';
import { deliverOrder } from '@/lib/server/order-delivery';
import { withPublic } from '@/lib/server/db';
import { createProject, addToProject } from '@/lib/server/library';
import { setTrackLicence } from '@/lib/server/storefront';
import { makeUser } from './helpers';

let fake: FakeStripe;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400_000;

function pdfStreams(buf: Buffer) {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const start = buf.indexOf('stream', i);
    if (start < 0) return out;
    const dataStart = start + (buf[start + 6] === 0x0d ? 8 : 7);
    const end = buf.indexOf('endstream', dataStart);
    try { out.push(inflateSync(buf.subarray(dataStart, end)).toString('latin1')); } catch { out.push(buf.subarray(dataStart, end).toString('latin1')); }
    i = end + 9;
  }
}

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
  fake = await startFakeStripe({
    webhookSecret: 'whsec_test_fake',
    webhook: async (payload, sig) => { try { await handleWebhook(payload, sig); return 200; } catch { return 400; } },
  });
  process.env.STRIPE_API_BASE = fake.url;
});
afterAll(async () => { await fake.close(); });

/** Producteur avec un morceau WAV réel en stockage, en vente. */
async function seller(plan: 'free' | 'pro' | 'studio' = 'free') {
  const u = await makeUser();
  const wav = await readFile('tests/fixtures/generated/ref01_140_Amin.wav');
  const trackId = await asService(async (tx) => {
    const [t] = await tx<{ id: string }[]>`insert into tracks (owner_id, title, bpm) values (${u.id}, 'Lueur froide', 140) returning id`;
    const key = `o/${t.id}.wav`;
    await store().put(key, wav, 50_000_000);
    const [v] = await tx<{ id: string }[]>`insert into track_versions (track_id, owner_id, version_no, label, status, original_filename, original_key, preview_key, duration_ms, format, sha256)
      values (${t.id}, ${u.id}, 1, 'v1', 'ready', 'lueur.wav', ${key}, ${key}, 24000, 'wav', ${sha256(wav)}) returning id`;
    await tx`update tracks set current_version_id = ${v.id} where id = ${t.id}`;
    await tx`update profiles set plan = ${plan} where user_id = ${u.id}`;
    return t.id;
  });
  await updateShareSettings(u.id, 'track', trackId, { visibility: 'for_sale' });
  const tpls = await listTemplates(u.id);
  return { ...u, trackId, sourceSha: sha256(wav), basic: tpls[0], premium: tpls[1], exclusive: tpls[2] };
}

const buyerEmail = () => `buyer_${randomUUID().slice(0, 8)}@client.fr`;
async function buy(s: Awaited<ReturnType<typeof seller>>, templateId: string, o: { country?: string; email?: string; card?: string } = {}) {
  const c = await startCheckout({ trackId: s.trackId, templateId, country: o.country ?? 'FR', email: o.email ?? buyerEmail(), waiver: true }, { buyerUserId: null, ip: `10.0.0.${Math.floor(Math.random() * 250)}` });
  const sessionId = new URL(c.url).pathname.split('/').pop()!;
  return { ...c, sessionId };
}
async function pay(sessionId: string, card = 'FR') {
  await fake.pay(sessionId, { cardCountry: card });
}
const order = async (id: string) => (await asService((tx) => tx<Record<string, any>[]>`select * from orders where id = ${id}`))[0];
const shares = (id: string) => asService((tx) => tx<{ userId: string; amountCents: number; status: string; isOwner: boolean; pct: number }[]>`
  select user_id as "userId", amount_cents as "amountCents", status, is_owner as "isOwner", pct::float as pct from order_shares where order_id = ${id} order by is_owner desc, pct desc`);

describe('Lot 4.3 — paiement (faux Stripe)', () => {
  it('1. achat de bout en bout : paiement, fichiers, licence, facture, email', async () => {
    const s = await seller();
    const email = buyerEmail();
    const c = await buy(s, s.premium.id, { country: 'DE', email });
    expect(c.url).toContain('/pay/');
    expect((await order(c.orderId)).status).toBe('pending');
    await pay(c.sessionId, 'DE');
    const o = await order(c.orderId);
    expect(o).toMatchObject({ status: 'paid', country: 'DE', card_country: 'DE', net_cents: 5900, vat_cents: 1121, gross_cents: 7021 });
    expect(Number(o.vat_rate)).toBe(19);
    expect(o.invoice_no).toMatch(/^F\d{4}-\d{6}$/);
    await drain();
    const view = await orderView(c.orderId);
    expect(view!.deliveredAt).not.toBeNull();
    expect(view!.files.map((f) => f.kind).sort()).toEqual(['invoice', 'licence', 'mp3', 'wav']);
    // Le WAV livré est le fichier d'origine, intact ; le MP3 est un vrai MP3.
    const wav = view!.files.find((f) => f.kind === 'wav')!;
    expect(wav.sha256).toBe(s.sourceSha);
    const mp3 = await orderFile(c.orderId, 'mp3');
    const mp3Bytes = await readFile(path.join(process.env.STORAGE_DIR!, mp3!.key));
    expect(mp3Bytes.subarray(0, 3).toString() === 'ID3' || (mp3Bytes[0] === 0xff && (mp3Bytes[1] & 0xe0) === 0xe0)).toBe(true);
    // Email à l'acheteur avec le lien de sa commande.
    const dir = process.env.MAIL_DIR!;
    const mails = await Promise.all((await readdir(dir)).map(async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf8'))));
    const m = mails.find((x) => x.to === email && x.tag === 'order');
    const token = /\/commande\/([A-Za-z0-9_-]{44})/.exec(m.text)![1];
    expect(parseOrderToken(token)).toBe(c.orderId);
    // Renonciation au droit de rétractation confirmée sur support durable (email ; la facture porte la même ligne).
    expect(m.text).toContain('renoncé à ton droit de rétractation');
    expect(mails.some((x) => x.to === s.email && x.tag === 'sale')).toBe(true);
    // Côté producteur et acheteur (même adresse, compte créé ensuite).
    expect((await listSales(s.id))[0]).toMatchObject({ trackTitle: 'Lueur froide', licenceName: 'Premium', status: 'paid' });
    const buyerAccount = await asService(async (tx) => (await tx<{ id: string }[]>`insert into users (email) values (${email}) returning id`)[0]);
    expect((await listPurchases(buyerAccount.id)).map((p) => p.id)).toEqual([c.orderId]);
    const stranger = await makeUser();
    expect(await listPurchases(stranger.id)).toEqual([]);
    expect(await withUser(stranger.id, (tx) => tx`select id from orders where id = ${c.orderId}`)).toEqual([]);
  });

  it('1b. on ne peut pas acheter ce qui n’est pas en vente', async () => {
    const s = await seller();
    await expect(startCheckout({ trackId: s.trackId, templateId: s.basic.id, country: 'ZZ', email: buyerEmail(), waiver: true }, { buyerUserId: null, ip: '1.1.1.1' })).rejects.toThrow();
    await updateShareSettings(s.id, 'track', s.trackId, { visibility: 'public' });
    await expect(buy(s, s.basic.id)).rejects.toThrow('plus disponible');
    await updateShareSettings(s.id, 'track', s.trackId, { visibility: 'for_sale' });
    const other = await seller();
    await expect(buy(s, other.basic.id)).rejects.toThrow('plus disponible');
  });

  it('2. factures numérotées sans trou, TVA du pays de l’acheteur ; une commande abandonnée ne prend pas de numéro', async () => {
    const s = await seller();
    const a = await buy(s, s.basic.id, { country: 'FR' });
    const abandoned = await buy(s, s.basic.id, { country: 'IT' });
    const b = await buy(s, s.basic.id, { country: 'HU' });
    const c = await buy(s, s.basic.id, { country: 'XX' });
    await pay(a.sessionId); await fake.expire(abandoned.sessionId); await pay(b.sessionId); await pay(c.sessionId);
    const [oa, ob, oc, ox] = await Promise.all([order(a.orderId), order(b.orderId), order(c.orderId), order(abandoned.orderId)]);
    expect(ox).toMatchObject({ status: 'expired', invoice_no: null });
    const n = (x: string) => Number(x.split('-')[1]);
    expect([n(ob.invoice_no) - n(oa.invoice_no), n(oc.invoice_no) - n(ob.invoice_no)]).toEqual([1, 1]);
    expect([Number(oa.vat_rate), oa.vat_cents, oa.gross_cents]).toEqual([20, 580, 3480]);
    expect([Number(ob.vat_rate), ob.vat_cents, ob.gross_cents]).toEqual([27, 783, 3683]);
    expect([Number(oc.vat_rate), oc.vat_cents, oc.gross_cents]).toEqual([0, 0, 2900]);
    await drain();
    const inv = (await orderView(b.orderId))!.files.find((f) => f.kind === 'invoice')!;
    expect(inv.filename).toBe(`Facture ${ob.invoice_no}.pdf`);
  });

  it('3. reversement = HT − commission de l’offre − frais Stripe ; parts au prorata, centime restant au propriétaire (3 offres)', async () => {
    // Fonction pure : 1 000 € de base, 33,33 % + 20 % ; le propriétaire touche le reste et les centimes.
    const sh = computeShares({ netCents: 100_001, commissionCents: 0, feeCents: 0, ownerId: 'o', splits: [{ userId: 'a', role: '', pct: 33.33 }, { userId: 'b', role: '', pct: 20 }] });
    expect(sh.map((x) => x.amountCents)).toEqual([100_001 - 33_330 - 20_000, 33_330, 20_000]);
    expect(sh.reduce((a, x) => a + x.amountCents, 0)).toBe(100_001);

    for (const plan of ['free', 'pro', 'studio'] as const) {
      const s = await seller(plan);
      const a = await makeUser(); const b = await makeUser();
      await setSplits(s.id, s.trackId, [{ handle: a.handle, role: 'Co-prod', pct: 33.33 }, { handle: b.handle, role: 'Topline', pct: 20 }]);
      await answer(a.id, s.trackId, true); await answer(b.id, s.trackId, true);
      const c = await buy(s, s.premium.id, { country: 'FR' });
      await pay(c.sessionId);
      const o = await order(c.orderId);
      const fee = Math.round(o.gross_cents * 0.015) + 25; // frais du faux Stripe, relus dans la transaction
      expect(o.stripe_fee_cents).toBe(fee);
      expect(o.commission_cents).toBe(commissionCents(5900, OFFERS[plan].commissionPct));
      const base = 5900 - o.commission_cents - fee;
      const rows = await shares(c.orderId);
      expect(rows.map((r) => r.amountCents)).toEqual([base - Math.floor(base * 0.3333) - Math.floor(base * 0.2), Math.floor(base * 0.3333), Math.floor(base * 0.2)]);
      expect(rows.reduce((x, r) => x + r.amountCents, 0)).toBe(base);
      expect(rows[0]).toMatchObject({ isOwner: true, pct: 46.67, userId: s.id });
      // Le collaborateur voit sa part, pas celles des autres.
      const seen = await listSales(a.id);
      expect(seen[0]).toMatchObject({ myShareCents: Math.floor(base * 0.3333), isSeller: false, shares: [] });
    }
    // Parts : total > 100 % refusé, identifiant inconnu refusé.
    const s = await seller(); const a = await makeUser();
    await expect(setSplits(s.id, s.trackId, [{ handle: a.handle, pct: 60 }, { handle: (await makeUser()).handle, pct: 41 }])).rejects.toThrow('100 %');
    await expect(setSplits(s.id, s.trackId, [{ handle: 'personne_xyz', pct: 10 }])).rejects.toThrow('inconnu');
  });

  it('4. remboursement avant 14 jours : virements annulés ; après : virements repris', async () => {
    const s = await seller('pro');
    const collab = await makeUser();
    await setSplits(s.id, s.trackId, [{ handle: collab.handle, pct: 25 }]);
    await answer(collab.id, s.trackId, true);
    for (const u of [s.id, collab.id]) { const { url } = await startOnboarding(u); fake.activate(/onboard\/([^?]+)/.exec(url)![1]); await refreshAccount(u); }

    const early = await buy(s, s.basic.id);
    await pay(early.sessionId);
    await refundBySeller(s.id, early.orderId);
    await sleep(300); // l'événement charge.refunded de Stripe arrive ensuite : sans effet de plus
    const oe = await order(early.orderId);
    expect(oe).toMatchObject({ status: 'refunded' });
    expect(oe.credit_note_no).toMatch(/^A\d{4}-\d{6}$/);
    expect((await shares(early.orderId)).map((r) => r.status)).toEqual(['canceled', 'canceled']);
    expect(await runTransfers(early.orderId, new Date(Date.now() + 15 * DAY))).toEqual({ transferred: 0, held: 0, failed: 0 });
    expect(fake.state.refunds.filter((r) => r.payment_intent === oe.payment_intent_id)).toHaveLength(1);
    await expect(refundBySeller(s.id, early.orderId)).rejects.toThrow('déjà remboursée');
    await drain();
    expect((await orderView(early.orderId))!.files.map((f) => f.kind)).toContain('credit_note');
    expect(await orderFile(early.orderId, 'wav')).toBeNull(); // plus de fichiers après remboursement
    expect(await orderFile(early.orderId, 'credit_note')).not.toBeNull();

    const late = await buy(s, s.basic.id);
    await pay(late.sessionId);
    expect(await runTransfers(late.orderId, new Date(Date.now() + 13 * DAY))).toEqual({ transferred: 0, held: 0, failed: 0 }); // pas avant 14 jours
    expect(await runTransfers(late.orderId, new Date(Date.now() + 15 * DAY))).toEqual({ transferred: 2, held: 0, failed: 0 });
    const transfers = fake.state.transfers.filter((t) => (t.metadata as Record<string, string>).order_id === late.orderId);
    const lateShares = await shares(late.orderId);
    expect(transfers.map((t) => t.amount).sort()).toEqual(lateShares.map((r) => r.amountCents).sort());
    expect(transfers.every((t) => t.source_transaction)).toBe(true);
    // Après le virement, le producteur ne peut plus rembourser seul : c'est Sonikc qui décide (support, litige).
    await expect(refundBySeller(s.id, late.orderId)).rejects.toThrow('support de Sonikc');
    expect((await listSales(s.id)).find((x) => x.id === late.orderId)!.refundable).toBe(false);
    await refundByPlatform(late.orderId, 'Remboursé par le support');
    expect((await shares(late.orderId)).map((r) => r.status)).toEqual(['reversed', 'reversed']);
    expect(fake.state.reversals.filter((r) => transfers.some((t) => t.id === r.transfer))).toHaveLength(2);
  });

  it('5. webhook rejoué : rien en double ; falsifié ou trop ancien : refusé', async () => {
    const s = await seller();
    const c = await buy(s, s.basic.id);
    await pay(c.sessionId);
    const ev = fake.state.events.find((e) => (e.data as { object: { id: string } }).object.id === c.sessionId && e.type === 'checkout.session.completed')!;
    const before = await order(c.orderId);
    expect(await fake.replay(ev.id as string)).toBe(200);
    await confirmPayment(c.sessionId); // même un second traitement direct ne change rien
    const after = await order(c.orderId);
    expect(after.invoice_no).toBe(before.invoice_no);
    expect(await shares(c.orderId)).toHaveLength(1);
    const [{ n }] = await asService((tx) => tx<{ n: number }[]>`select count(*)::int as n from jobs where kind = 'order_deliver' and payload->>'orderId' = ${c.orderId}`);
    expect(n).toBe(1);
    expect(await fake.replay(ev.id as string, { tamper: true })).toBe(400);
    expect(await fake.replay(ev.id as string, { oldTimestamp: true })).toBe(400);
    await expect(handleWebhook('{"id":"evt_x","type":"checkout.session.completed"}', 't=1,v1=abc')).rejects.toThrow();
    await expect(handleWebhook('{}', null)).rejects.toThrow();
  });

  it('6. exclusive : un seul paiement à la fois ; le second payé malgré tout est remboursé', async () => {
    const s = await seller();
    const first = await buy(s, s.exclusive.id);
    await expect(buy(s, s.exclusive.id)).rejects.toThrow('en train d’acheter');
    // Deux débuts simultanés : un seul passe.
    const s2 = await seller();
    const both = await Promise.allSettled([buy(s2, s2.exclusive.id), buy(s2, s2.exclusive.id)]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // Cas limite : la réservation a expiré, un second acheteur commence, puis les deux paient.
    await asService((tx) => tx`update tracks set exclusive_reserved_until = now() - interval '1 minute' where id = ${s.trackId}`);
    const second = await buy(s, s.exclusive.id);
    await pay(first.sessionId);
    await pay(second.sessionId);
    await sleep(300);
    expect((await order(first.orderId)).status).toBe('paid');
    const o2 = await order(second.orderId);
    expect(o2.status).toBe('refunded');
    expect(o2.refund_reason).toContain('Exclusive déjà vendue');
    const [t] = await asService((tx) => tx<{ soldOrder: string; soldAt: Date }[]>`select exclusive_sold_order as "soldOrder", exclusive_sold_at as "soldAt" from tracks where id = ${s.trackId}`);
    expect(t.soldOrder).toBe(first.orderId);
    await expect(buy(s, s.basic.id)).rejects.toThrow('plus disponible'); // retiré de la vente
  });

  it('7. sans compte de reversement actif, la part attend ; l’activation la libère', async () => {
    const s = await seller();
    const c = await buy(s, s.basic.id);
    await pay(c.sessionId);
    expect(await runTransfers(c.orderId, new Date(Date.now() + 15 * DAY))).toEqual({ transferred: 0, held: 1, failed: 0 });
    expect((await shares(c.orderId))[0].status).toBe('held');
    const { url } = await startOnboarding(s.id);
    expect(url).toContain('/onboard/acct_');
    expect((await startOnboarding(s.id)).url).toBe(url); // même compte, pas de doublon
    fake.activate(/onboard\/([^?]+)/.exec(url)![1]);
    const r = await refreshAccount(s.id);
    expect(r).toMatchObject({ transfersActive: true, justActivated: true });
    const [{ n }] = await asService((tx) => tx<{ n: number }[]>`select count(*)::int as n from jobs where kind = 'order_transfers' and payload->>'orderId' = ${c.orderId} and status = 'queued' and run_after <= now()`);
    expect(n).toBe(1);
    expect(await runTransfers(c.orderId, new Date(Date.now() + 15 * DAY))).toEqual({ transferred: 1, held: 0, failed: 0 });
    expect((await shares(c.orderId))[0].status).toBe('transferred');
  });
});

describe('Lot 4.4 — certificat', () => {
  it('1. l’empreinte du certificat est celle du fichier livré ; PDF de licence qui la porte', async () => {
    const s = await seller();
    const c = await buy(s, s.premium.id);
    await pay(c.sessionId);
    await drain();
    const [cert] = await asService((tx) => tx<{ files: { format: string; sha256: string }[]; sourceSha: string; parties: { collaborators: unknown[] } }[]>`
      select files, source_sha256 as "sourceSha", parties from licence_certificates where order_id = ${c.orderId}`);
    expect(cert.sourceSha).toBe(s.sourceSha);
    for (const f of cert.files) {
      const file = await orderFile(c.orderId, f.format);
      expect(sha256(await readFile(path.join(process.env.STORAGE_DIR!, file!.key)))).toBe(f.sha256);
    }
    const lic = await orderFile(c.orderId, 'licence');
    const raw = await readFile(path.join(process.env.STORAGE_DIR!, lic!.key));
    expect(raw.subarray(0, 5).toString()).toBe('%PDF-');
    // Texte des pages : flux décompressés ; pdf-lib écrit le texte en hexadécimal (police standard, WinAnsi).
    const text = pdfStreams(raw).join('\n');
    const hex = (str: string) => Buffer.from(str, 'latin1').toString('hex').toUpperCase();
    for (const f of cert.files) expect(text.includes(hex(`SHA-256 : ${f.sha256}`))).toBe(true);
  });

  it('2. certificat, parts et vente verrouillés par la base', async () => {
    const s = await seller();
    const c = await buy(s, s.basic.id);
    await pay(c.sessionId);
    await drain();
    await expect(asService((tx) => tx`update licence_certificates set source_sha256 = ${'0'.repeat(64)} where order_id = ${c.orderId}`)).rejects.toThrow('locked');
    await expect(asService((tx) => tx`delete from licence_certificates where order_id = ${c.orderId}`)).rejects.toThrow('locked');
    await expect(asService((tx) => tx`update order_shares set amount_cents = 1 where order_id = ${c.orderId}`)).rejects.toThrow('locked');
    await expect(asService((tx) => tx`update order_files set sha256 = ${'0'.repeat(64)} where order_id = ${c.orderId}`)).rejects.toThrow('locked');
    await expect(asService((tx) => tx`update orders set net_cents = 1 where id = ${c.orderId}`)).rejects.toThrow('locked');
    await expect(asService((tx) => tx`delete from orders where id = ${c.orderId}`)).rejects.toThrow();
    // L'app n'a aucun droit d'écriture sur les ventes.
    await expect(withUser(s.id, (tx) => tx`update orders set status = 'refunded' where id = ${c.orderId}`)).rejects.toThrow('permission denied');
    await expect(withUser(s.id, (tx) => tx`insert into order_shares (order_id, user_id, is_owner, pct, amount_cents) values (${c.orderId}, ${s.id}, false, 1, 1)`)).rejects.toThrow('permission denied');
  });
});

/** Le collaborateur répond à la proposition telle qu'il la voit dans « Ventes ». */
async function answer(userId: string, trackId: string, accept: boolean) {
  const i = (await listSplitInvites(userId)).find((x) => x.trackId === trackId);
  if (!i) throw new Error('aucune invitation');
  await respondSplit(userId, trackId, { accept, pct: i.pct, role: i.role, invitedAt: i.invitedAt });
}

/** Producteur et collaborateur avec comptes de reversement actifs. */
async function activeSeller() {
  const s = await seller('pro');
  const collab = await makeUser();
  await setSplits(s.id, s.trackId, [{ handle: collab.handle, pct: 25 }]);
  await answer(collab.id, s.trackId, true);
  for (const u of [s.id, collab.id]) { const { url } = await startOnboarding(u); fake.activate(/onboard\/([^?]+)/.exec(url)![1]); await refreshAccount(u); }
  return { ...s, collab };
}
const later = (days: number) => new Date(Date.now() + days * DAY);

describe('Lot 4.3 — relecture indépendante : reprises après panne et cas limites', () => {
  beforeEach(() => fake.clearFailures());
  it('H4. licence simple payée après la vente de l’exclusive : remboursée automatiquement', async () => {
    const s = await seller();
    const lease = await buy(s, s.basic.id);
    const excl = await buy(s, s.exclusive.id);
    await pay(excl.sessionId);
    await pay(lease.sessionId);
    const o = await order(lease.orderId);
    expect(o.status).toBe('refunded');
    expect(o.refund_reason).toContain('Exclusivité vendue');
    const [{ n }] = await asService((tx) => tx<{ n: number }[]>`select count(*)::int as n from jobs where kind = 'order_deliver' and payload->>'orderId' = ${lease.orderId}`);
    expect(n).toBe(0);
  });

  it('H1. remboursement automatique en panne : repris par le balayage', async () => {
    const s = await seller();
    const first = await buy(s, s.exclusive.id);
    await asService((tx) => tx`update tracks set exclusive_reserved_until = now() - interval '1 minute' where id = ${s.trackId}`);
    const second = await buy(s, s.exclusive.id);
    await pay(first.sessionId);
    fake.failNext(/^\/v1\/refunds$/, 500);
    fake.failNext(/^\/v1\/refunds$/, 500); // les essais internes du SDK aussi
    fake.failNext(/^\/v1\/refunds$/, 500);
    await pay(second.sessionId);
    let o = await order(second.orderId);
    expect(o.status).toBe('paid');
    expect(o.refund_requested_at).not.toBeNull();
    expect((await orderView(second.orderId))!.refundRequestedAt).not.toBeNull();
    await sweepPayments(later(1));
    await sleep(200);
    o = await order(second.orderId);
    expect(o.status).toBe('refunded');
    expect(fake.state.refunds.filter((r) => r.payment_intent === o.payment_intent_id)).toHaveLength(1);
  });

  it('L2. remboursement déjà fait depuis le tableau de bord Stripe : accepté', async () => {
    const s = await seller();
    const c = await buy(s, s.basic.id);
    await pay(c.sessionId);
    const o = await order(c.orderId);
    await fake.refundFromDashboard(o.payment_intent_id);
    await refundBySeller(s.id, c.orderId).catch(async (e) => { if (!String(e.message).includes('déjà remboursée')) throw e; });
    await sleep(200);
    expect((await order(c.orderId)).status).toBe('refunded');
  });

  it('H2. virement en panne puis réponse perdue : repris sans doublon', async () => {
    const s = await activeSeller();
    const c = await buy(s, s.basic.id);
    await pay(c.sessionId);
    for (let i = 0; i < 3; i++) fake.failNext(/^\/v1\/transfers$/, 500);
    let r = await runTransfers(c.orderId, later(15));
    expect(r.failed).toBeGreaterThan(0);
    // Second essai : Stripe fait le virement mais la réponse se perd.
    for (let i = 0; i < 3; i++) fake.failNext(/^\/v1\/transfers$/, 500, { afterSuccess: true });
    r = await runTransfers(c.orderId, later(16));
    // Troisième passage (balayage) : on retrouve le virement fait au lieu d'en refaire un.
    await sweepPayments(later(17));
    const rows = await shares(c.orderId);
    expect(rows.map((x) => x.status)).toEqual(['transferred', 'transferred']);
    const transfers = fake.state.transfers.filter((t) => (t.metadata as Record<string, string>).order_id === c.orderId);
    for (const x of rows) expect(transfers.filter((t) => (t.metadata as Record<string, string>).user_id === x.userId)).toHaveLength(1);
  });

  it('H3. reprise de virement en panne après remboursement : reprise plus tard', async () => {
    const s = await activeSeller();
    const c = await buy(s, s.basic.id);
    await pay(c.sessionId);
    expect((await runTransfers(c.orderId, later(15))).transferred).toBe(2);
    for (let i = 0; i < 30; i++) fake.failNext(/\/reversals$/, 500); // Stripe en panne un moment (le webhook de remboursement réessaie aussi)
    await refundByPlatform(c.orderId, 'Litige réglé par le support');
    await sleep(300);
    expect((await shares(c.orderId)).some((x) => x.status === 'transferred')).toBe(true);
    fake.clearFailures(); // Stripe revient
    await sweepPayments(later(16));
    expect((await shares(c.orderId)).map((x) => x.status)).toEqual(['reversed', 'reversed']);
  });

  it('M3. charge remboursée avant la confirmation ; litige : parts bloquées puis libérées', async () => {
    const s = await activeSeller();
    const c = await buy(s, s.basic.id);
    await fake.pay(c.sessionId, { webhook: false });
    const pi = (fake.state.sessions.get(c.sessionId) as { payment_intent: string }).payment_intent;
    await fake.refundFromDashboard(pi);
    await sleep(200); // charge.refunded arrive avant la confirmation : sans effet
    await confirmPayment(c.sessionId);
    expect((await order(c.orderId)).status).toBe('refunded');
    expect(fake.state.refunds.filter((r) => r.payment_intent === pi)).toHaveLength(1);

    const d = await buy(s, s.basic.id);
    await pay(d.sessionId);
    const dpi = (await order(d.orderId)).payment_intent_id;
    expect(await fake.emitEvent('charge.dispute.created', { id: 'dp_1', object: 'dispute', payment_intent: dpi, status: 'needs_response' })).toBe(200);
    expect((await shares(d.orderId)).map((x) => x.status)).toEqual(['disputed', 'disputed']);
    expect(await runTransfers(d.orderId, later(15))).toEqual({ transferred: 0, held: 0, failed: 0 });
    await fake.emitEvent('charge.dispute.closed', { id: 'dp_1', object: 'dispute', payment_intent: dpi, status: 'won' });
    expect((await runTransfers(d.orderId, later(15))).transferred).toBe(2);
  });

  it('M4. parts calculées en entiers : jamais un centime perdu', () => {
    expect(computeShares({ netCents: 375, commissionCents: 0, feeCents: 0, ownerId: 'o', splits: [{ userId: 'a', role: '', pct: 18.4 }] })[1].amountCents).toBe(69);
    for (let i = 0; i < 2000; i++) {
      const base = 100 + Math.floor(Math.random() * 1_000_000);
      const pcts = [Math.floor(Math.random() * 4000) / 100, Math.floor(Math.random() * 4000) / 100];
      const sh = computeShares({ netCents: base, commissionCents: 0, feeCents: 0, ownerId: 'o', splits: pcts.map((pct, k) => ({ userId: `c${k}`, role: '', pct })) });
      pcts.forEach((pct, k) => expect(sh[k + 1].amountCents).toBe(Number((BigInt(base) * BigInt(Math.round(pct * 100))) / 10000n)));
      expect(sh.reduce((a, x) => a + x.amountCents, 0)).toBe(base);
    }
  });

  it('M6. email de livraison en échec : renvoyé au passage suivant', async () => {
    const s = await seller();
    const email = buyerEmail();
    const c = await buy(s, s.basic.id, { email });
    await pay(c.sessionId);
    const dir = process.env.MAIL_DIR!;
    process.env.MAIL_DIR = path.join(process.env.STORAGE_DIR!, 'o', `${s.trackId}.wav`); // un fichier : écriture impossible
    await expect(deliverOrder(c.orderId)).rejects.toThrow();
    process.env.MAIL_DIR = dir;
    expect((await order(c.orderId)).buyer_notified_at).toBeNull();
    await deliverOrder(c.orderId);
    expect((await order(c.orderId)).buyer_notified_at).not.toBeNull();
    const mails = await Promise.all((await readdir(dir)).map(async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf8'))));
    expect(mails.filter((m) => m.to === email && m.tag === 'order')).toHaveLength(1);
  });

  it('M5, M7, M8. limites, preuves du pays, email de l’acheteur caché aux collaborateurs', async () => {
    const s = await seller();
    await expect(startCheckout({ trackId: s.trackId, templateId: s.basic.id, country: 'constructor', email: buyerEmail(), waiver: true }, { buyerUserId: null, ip: '9.9.9.9' }))
      .rejects.toThrow();
    // Exclusive : deux essais par jour et par personne au plus.
    for (let i = 0; i < 2; i++) {
      const c = await startCheckout({ trackId: s.trackId, templateId: s.exclusive.id, country: 'FR', email: 'grief@x.fr', waiver: true }, { buyerUserId: null, ip: '7.7.7.7' });
      await fake.expire(new URL(c.url).pathname.split('/').pop()!);
    }
    await expect(startCheckout({ trackId: s.trackId, templateId: s.exclusive.id, country: 'FR', email: 'grief@x.fr', waiver: true }, { buyerUserId: null, ip: '7.7.7.7' }))
      .rejects.toThrow('deux fois');
    // Déclaré hors UE, carte française : signalé.
    const c = await buy(s, s.basic.id, { country: 'XX' });
    await pay(c.sessionId, 'FR');
    expect((await order(c.orderId)).country_conflict).toBe(true);
    const ok = await buy(s, s.basic.id, { country: 'FR' });
    await pay(ok.sessionId, 'FR');
    expect((await order(ok.orderId)).country_conflict).toBe(false);
    // Collaborateur : sa part, jamais l'email de l'acheteur.
    const a = await activeSeller();
    const d = await buy(a, a.basic.id);
    await pay(d.sessionId);
    expect((await listSales(a.collab.id))[0].buyerEmail).toBeNull();
    expect((await listSales(a.id))[0].buyerEmail).toMatch(/@client\.fr$/);
  });

  it('L1. le catalogue public ne lit ni les ventes ni les données des morceaux privés', async () => {
    const s = await activeSeller();
    const c = await buy(s, s.basic.id);
    await pay(c.sessionId);
    await drain();
    const priv = await asService(async (tx) => (await tx<{ id: string }[]>`insert into tracks (owner_id, title, visibility) values (${s.id}, 'Secret', 'private') returning id`)[0]);
    await setTrackLicence(s.id, priv.id, s.basic.id, { enabled: true, priceCents: 999 });
    const p = await createProject(s.id, { title: 'Projet privé' });
    await addToProject(s.id, p.id, [s.trackId]);
    const seen = await withPublic(async (tx) => ({
      orders: await tx`select id from orders`, shares: await tx`select 1 from order_shares`, files: await tx`select 1 from order_files`,
      certs: await tx`select 1 from licence_certificates`, splits: await tx`select 1 from track_splits`, accounts: await tx`select 1 from stripe_accounts`,
      priv: await tx`select 1 from track_licences where track_id = ${priv.id}`, members: await tx`select 1 from project_tracks where project_id = ${p.id}`,
    }));
    for (const [k, v] of Object.entries(seen)) expect([k, v.length]).toEqual([k, 0]);
  });
});

describe('Lot 4.3 — choix du 20/11 : accord des collaborateurs, remboursement par le producteur', () => {
  it('une part ne s’applique qu’après l’accord du collaborateur ; lui seul répond', async () => {
    const s = await seller();
    const a = await makeUser(); const b = await makeUser();
    await setSplits(s.id, s.trackId, [{ handle: a.handle, pct: 30 }, { handle: b.handle, pct: 20 }]);
    expect((await listSplits(s.id, s.trackId)).map((x) => x.status)).toEqual(['pending', 'pending']);
    // Invitation reçue par email et visible dans « Ventes ».
    expect((await listSplitInvites(a.id)).map((x) => [x.trackTitle, x.pct, x.status])).toEqual([['Lueur froide', 30, 'pending']]);
    const dir = process.env.MAIL_DIR!;
    const mails = await Promise.all((await readdir(dir)).map(async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf8'))));
    expect(mails.some((m) => m.to === a.email && m.tag === 'split_invite')).toBe(true);
    // Le propriétaire ne peut pas accepter à sa place ; un inconnu ne peut pas répondre ; le collaborateur ne change pas sa part.
    await expect(withUser(s.id, (tx) => tx`update track_splits set status = 'accepted' where track_id = ${s.trackId}`)).rejects.toThrow('only the collaborator');
    await expect(respondSplit((await makeUser()).id, s.trackId, { accept: true, pct: 30, role: '', invitedAt: new Date().toISOString() })).rejects.toThrow();
    await expect(withUser(a.id, (tx) => tx`update track_splits set pct = 90 where track_id = ${s.trackId} and collaborator_id = ${a.id}`)).rejects.toThrow('belong to the owner');
    const c3 = await makeUser();
    await withUser(s.id, (tx) => tx`insert into track_splits (track_id, owner_id, collaborator_id, pct, status) values (${s.trackId}, ${s.id}, ${c3.id}, 5, 'accepted')`);
    expect((await listSplits(s.id, s.trackId)).filter((x) => x.status === 'accepted')).toHaveLength(0); // statut forcé « en attente »
    await withUser(s.id, (tx) => tx`delete from track_splits where track_id = ${s.trackId} and collaborator_id = ${c3.id}`);
    // Vente avant tout accord : 100 % au propriétaire.
    const c1 = await buy(s, s.basic.id); await pay(c1.sessionId);
    expect((await shares(c1.orderId)).map((x) => x.isOwner)).toEqual([true]);
    // A accepte, B refuse : seule la part de A s'applique ; la part refusée ne compte plus dans le total.
    await answer(a.id, s.trackId, true);
    await answer(b.id, s.trackId, false);
    await expect(answer(a.id, s.trackId, false)).rejects.toThrow(); // déjà répondu
    const c2 = await buy(s, s.basic.id); await pay(c2.sessionId);
    expect((await shares(c2.orderId)).map((x) => [x.isOwner, x.pct])).toEqual([[true, 70], [false, 30]]);
    // Changer le pourcentage redemande l'accord ; une ligne inchangée garde la réponse.
    await setSplits(s.id, s.trackId, [{ handle: a.handle, pct: 35 }, { handle: b.handle, pct: 20 }]);
    const after = await listSplits(s.id, s.trackId);
    expect(after.map((x) => [x.handle, x.status])).toEqual([[a.handle, 'pending'], [b.handle, 'declined']]);
  });

  it('remboursement par le producteur : possible jusqu’au virement, ensuite par Sonikc seulement', async () => {
    const s = await activeSeller();
    const c = await buy(s, s.basic.id);
    await pay(c.sessionId);
    expect((await listSales(s.id))[0].refundable).toBe(true);
    await runTransfers(c.orderId, later(15));
    await expect(refundBySeller(s.id, c.orderId)).rejects.toThrow('support de Sonikc');
    expect((await order(c.orderId)).refund_requested_at).toBeNull();
    // Commission : offre Pro à 0 %.
    expect((await order(c.orderId)).commission_cents).toBe(0);
  });
});

describe('Lot 4.3 — seconde relecture : accord des collaborateurs et remboursements', () => {
  beforeEach(() => fake.clearFailures());
  const mailsTo = async (email: string, tag: string) => {
    const dir = process.env.MAIL_DIR!;
    const all = await Promise.all((await readdir(dir)).map(async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf8'))));
    return all.filter((m) => m.to === email && m.tag === tag);
  };

  it('H1/M4. une acceptation ne se déplace pas ; dates et réponses verrouillées', async () => {
    const s = await seller(); const other = await seller();
    const a = await makeUser(); const x = await makeUser();
    await setSplits(s.id, s.trackId, [{ handle: a.handle, pct: 10 }]);
    await answer(a.id, s.trackId, true);
    await expect(withUser(s.id, (tx) => tx`update track_splits set collaborator_id = ${x.id} where track_id = ${s.trackId}`)).rejects.toThrow('permission denied');
    await expect(withUser(s.id, (tx) => tx`update track_splits set track_id = ${other.trackId} where track_id = ${s.trackId}`)).rejects.toThrow('permission denied');
    await expect(asService((tx) => tx`update track_splits set collaborator_id = ${x.id} where track_id = ${s.trackId}`)).rejects.toThrow('cannot be moved');
    await expect(withUser(a.id, (tx) => tx`update track_splits set invited_at = now() - interval '1 year' where track_id = ${s.trackId}`)).rejects.toThrow('permission denied');
    await expect(withUser(s.id, (tx) => tx`update track_splits set responded_at = now() where track_id = ${s.trackId}`)).rejects.toThrow('permission denied');
    // Refus définitif pour ces conditions : pas de retour direct à « accepté ».
    const b = await makeUser();
    await setSplits(s.id, s.trackId, [{ handle: a.handle, pct: 10 }, { handle: b.handle, pct: 20 }]);
    await answer(b.id, s.trackId, false);
    await expect(withUser(b.id, (tx) => tx`update track_splits set status = 'accepted' where track_id = ${s.trackId} and collaborator_id = ${b.id}`)).rejects.toThrow('invalid split answer');
  });

  it('nouvelles conditions : les anciennes restent en vigueur jusqu’à l’accord ; retrait ; ligne inchangée ; retirer puis rajouter', async () => {
    const s = await seller();
    const a = await makeUser(); const b = await makeUser(); const c = await makeUser();
    await setSplits(s.id, s.trackId, [{ handle: a.handle, role: 'Co-prod', pct: 30 }, { handle: b.handle, pct: 20 }]);
    await answer(a.id, s.trackId, true); await answer(b.id, s.trackId, true);
    // Ligne inchangée : reste acceptée. Rôle changé : redemande l'accord, 30 % restent en vigueur.
    await setSplits(s.id, s.trackId, [{ handle: a.handle, role: 'Mix', pct: 30 }, { handle: b.handle, pct: 20 }]);
    let rows = await listSplits(s.id, s.trackId);
    expect(rows.map((r) => [r.handle, r.status, r.acceptedPct])).toEqual([[a.handle, 'pending', 30], [b.handle, 'accepted', 20]]);
    const c1 = await buy(s, s.basic.id); await pay(c1.sessionId);
    expect((await shares(c1.orderId)).map((r) => [r.isOwner, r.pct])).toEqual([[true, 50], [false, 30], [false, 20]]);
    // Proposition à la hausse refusée : l'ancienne part reste en vigueur.
    await setSplits(s.id, s.trackId, [{ handle: a.handle, role: 'Mix', pct: 40 }, { handle: b.handle, pct: 20 }]);
    await answer(a.id, s.trackId, false);
    rows = await listSplits(s.id, s.trackId);
    expect(rows.find((r) => r.handle === a.handle)).toMatchObject({ status: 'declined', acceptedPct: 30 });
    // Retrait de B : sa part cesse de s'appliquer ; la place libérée peut être proposée à C.
    await withdrawSplit(b.id, s.trackId);
    await setSplits(s.id, s.trackId, [{ handle: a.handle, role: 'Mix', pct: 40 }, { handle: b.handle, pct: 20 }, { handle: c.handle, pct: 50 }]);
    const c2 = await buy(s, s.basic.id); await pay(c2.sessionId);
    expect((await shares(c2.orderId)).map((r) => [r.isOwner, r.pct])).toEqual([[true, 70], [false, 30]]);
    // Retirer puis rajouter : nouvelle invitation, rien en vigueur.
    await setSplits(s.id, s.trackId, [{ handle: c.handle, pct: 50 }]);
    await setSplits(s.id, s.trackId, [{ handle: c.handle, pct: 50 }, { handle: a.handle, pct: 10 }]);
    expect((await listSplits(s.id, s.trackId)).find((r) => r.handle === a.handle)).toMatchObject({ status: 'pending', acceptedPct: null });
    // Réponse à une proposition qui a changé entre-temps : refusée.
    const seen = (await listSplitInvites(c.id))[0];
    await setSplits(s.id, s.trackId, [{ handle: c.handle, pct: 5 }, { handle: a.handle, pct: 10 }]);
    await expect(respondSplit(c.id, s.trackId, { accept: true, pct: seen.pct, role: seen.role, invitedAt: seen.invitedAt })).rejects.toThrow('a changé');
  });

  it('M2. invitations limitées : une par personne et par 24 h, texte sur une ligne', async () => {
    const s = await seller();
    await asService((tx) => tx`update tracks set title = ${'Titre\r\nBcc: x@evil.example'} where id = ${s.trackId}`);
    const a = await makeUser();
    for (const pct of [10, 10.01, 10, 12]) await setSplits(s.id, s.trackId, [{ handle: a.handle, pct }]);
    await setSplits(s.id, s.trackId, []);
    await setSplits(s.id, s.trackId, [{ handle: a.handle, pct: 15 }]);
    const mails = await mailsTo(a.email, 'split_invite');
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).not.toMatch(/[\r\n]/);
  });

  it('H2. un remboursement par le producteur ne peut pas s’intercaler pendant un virement', async () => {
    const s = await activeSeller();
    const c = await buy(s, s.basic.id);
    await pay(c.sessionId);
    fake.delayNext(/^\/v1\/transfers$/, 600);
    const running = runTransfers(c.orderId, later(15));
    await sleep(150);
    await expect(refundBySeller(s.id, c.orderId)).rejects.toThrow('support de Sonikc');
    await running;
    expect((await order(c.orderId)).status).toBe('paid');
    expect((await shares(c.orderId)).every((r) => r.status === 'transferred')).toBe(true);
  });

  it('M1. réponse de Stripe perdue : plus de remboursement par le producteur ; Sonikc rembourse et reprend le virement parti', async () => {
    const s = await activeSeller();
    const c = await buy(s, s.basic.id);
    await pay(c.sessionId);
    for (let i = 0; i < 3; i++) fake.failNext(/^\/v1\/transfers$/, 500, { afterSuccess: true });
    const r0 = await runTransfers(c.orderId, later(15));
    expect(r0).toMatchObject({ transferred: 1, failed: 1 });
    expect((await shares(c.orderId)).some((r) => r.status === 'scheduled')).toBe(true);
    await expect(refundBySeller(s.id, c.orderId)).rejects.toThrow('support de Sonikc');
    expect((await listSales(s.id))[0].refundable).toBe(false);
    await refundByPlatform(c.orderId, 'Remboursé par le support');
    await sweepPayments(later(16));
    const sent = fake.state.transfers.filter((t) => (t.metadata as Record<string, string>).order_id === c.orderId);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((t) => t.reversed)).toBe(true);
  });

  it('remboursement par Sonikc avant virement ; virements jamais lancés pendant un remboursement demandé', async () => {
    const s = await activeSeller();
    const c = await buy(s, s.basic.id);
    await pay(c.sessionId);
    await asService((tx) => tx`update orders set refund_requested_at = now() where id = ${c.orderId}`);
    expect(await runTransfers(c.orderId, later(15))).toEqual({ transferred: 0, held: 0, failed: 0 });
    await refundByPlatform(c.orderId, 'Remboursé par le support');
    expect((await order(c.orderId)).status).toBe('refunded');
    expect((await shares(c.orderId)).map((r) => r.status)).toEqual(['canceled', 'canceled']);
  });

  it('les factures suivent le mode de Stripe (clé réelle refusée en mode test)', async () => {
    const s = await seller();
    const key = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_live_x';
    try { await expect(buy(s, s.basic.id)).rejects.toThrow('Clé Stripe réelle'); } finally { process.env.STRIPE_SECRET_KEY = key; }
  });
});

describe('Stripe réel : frais connus avec retard', () => {
  it('les parts ne sont figées qu’avec les vrais frais Stripe, même s’ils arrivent après quelques secondes', async () => {
    const s = await seller();
    const c = await buy(s, s.basic.id);
    fake.feeLate(2);
    await pay(c.sessionId);
    const o = await order(c.orderId);
    expect(o.status).toBe('paid');
    expect(o.stripe_fee_cents).toBe(Math.round(o.gross_cents * 0.015) + 25);
    fake.clearFailures();
  }, 20_000);
});

describe('Lot 5.1 — commission figée sur la vente', () => {
  it('un changement d’offre ne modifie pas la commission d’une vente déjà commencée ou payée', async () => {
    const s = await seller('free');
    const c = await buy(s, s.basic.id);
    await asService((tx) => tx`update profiles set plan = 'pro' where user_id = ${s.id}`);
    await pay(c.sessionId);
    const o = await order(c.orderId);
    expect(Number(o.commission_pct)).toBe(OFFERS.free.commissionPct);
    expect(o.commission_cents).toBe(commissionCents(o.net_cents, OFFERS.free.commissionPct));
    const c2 = await buy(s, s.basic.id);
    expect(Number((await order(c2.orderId)).commission_pct)).toBe(OFFERS.pro.commissionPct);
  });
});
