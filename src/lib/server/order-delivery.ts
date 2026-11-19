import { mkdtemp, readFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asService } from './db';
import { store } from './storage';
import { convert } from './ffmpeg';
import { sha256 } from './crypto';
import { sendMail } from './mail';
import { renderPdf, type Block } from './pdf';
import { orderUrl } from './commerce';
import { FORMAT_LABEL, euros, licenceLines, type LicenceTerms } from '../licences';
import { COMPANY } from '@/config/company';
import { EU_VAT } from '@/config/vat';

/**
 * Livraison d'une commande payée (tâche du worker) : fichiers audio aux formats de la licence, certificat,
 * PDF de licence et facture, puis email à l'acheteur et au producteur. Reprend là où un essai précédent s'est arrêté.
 */

const LOSSLESS = new Set(['wav', 'flac', 'aiff', 'w64', 'caf']);
const MAX_FILE = 1_000_000_000;

type Order = {
  id: string; status: string; trackTitle: string; sellerName: string; sellerId: string; licence: LicenceTerms & { name: string; description: string };
  buyerEmail: string; country: string; netCents: number; vatRate: number; vatCents: number; grossCents: number;
  invoiceNo: string; creditNoteNo: string | null; paidAt: Date; refundedAt: Date | null; deliveredAt: Date | null; buyerNotifiedAt: Date | null;
  refundRequested: Date | null;
  originalKey: string | null; format: string | null; sourceSha: string | null; sellerHandle: string;
};

async function loadOrder(orderId: string) {
  const [o] = await asService((tx) => tx<Order[]>`
    select o.id, o.status, o.track_title as "trackTitle", o.seller_name as "sellerName", o.seller_id as "sellerId", o.licence,
           o.buyer_email as "buyerEmail", o.country, o.net_cents as "netCents", o.vat_rate::float as "vatRate", o.vat_cents as "vatCents",
           o.gross_cents as "grossCents", o.invoice_no as "invoiceNo", o.credit_note_no as "creditNoteNo", o.paid_at as "paidAt",
           o.refunded_at as "refundedAt", o.delivered_at as "deliveredAt", o.buyer_notified_at as "buyerNotifiedAt",
           o.refund_requested_at as "refundRequested",
           v.original_key as "originalKey", v.format, v.sha256 as "sourceSha", p.handle as "sellerHandle"
    from orders o left join track_versions v on v.id = o.version_id join profiles p on p.user_id = o.seller_id
    where o.id = ${orderId}`);
  return o ?? null;
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'beat';
const dateFr = (d: Date) => d.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric' });
const utc = (d: Date) => d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
const countryName = (c: string) => EU_VAT[c]?.name ?? 'Hors Union européenne';
const testBanner: Block[] = COMPANY.testMode ? [{ kind: 'text', text: 'DOCUMENT DE TEST — paiement en mode test Stripe, sans valeur commerciale ni fiscale.', muted: true }, { kind: 'space' }] : [];

async function putFile(orderId: string, kind: string, ext: string, filename: string, buf: Buffer, contentType?: string) {
  // Clé tirée du contenu : un essai concurrent ou tardif ne peut jamais écraser le fichier déjà enregistré.
  const hash = sha256(buf);
  const key = `orders/${orderId}/${kind}-${hash.slice(0, 16)}.${ext}`;
  await store().put(key, buf, MAX_FILE, contentType);
  await asService((tx) => tx`insert into order_files (order_id, kind, storage_key, filename, sha256, size_bytes)
    values (${orderId}, ${kind}, ${key}, ${filename}, ${hash}, ${buf.length}) on conflict (order_id, kind) do nothing`);
  const [f] = await asService((tx) => tx<{ sha256: string; size: number; filename: string }[]>`
    select sha256, size_bytes::int as size, filename from order_files where order_id = ${orderId} and kind = ${kind}`);
  return f;
}

async function existing(orderId: string) {
  const rows = await asService((tx) => tx<{ kind: string; sha256: string; size: number; filename: string }[]>`
    select kind, sha256, size_bytes::int as size, filename from order_files where order_id = ${orderId}`);
  return new Map(rows.map((r) => [r.kind, r]));
}

export async function deliverOrder(orderId: string) {
  const o = await loadOrder(orderId);
  if (!o || o.status !== 'paid' || o.refundRequested || o.buyerNotifiedAt) return;
  if (!o.originalKey || !o.sourceSha) throw new Error('fichier source introuvable');
  const have = await existing(orderId);
  const base = safeName(`${o.trackTitle} - ${o.sellerName} (${o.licence.name})`);

  // 1. Fichiers audio.
  const tmp = await mkdtemp(path.join(tmpdir(), 'sonikc-order-'));
  try {
    const formats = o.licence.formats.filter((f) => f === 'mp3' || f === 'wav');
    if (formats.some((f) => !have.has(f))) {
      const src = await store().toLocalFile(o.originalKey, tmp);
      for (const fmt of formats) {
        if (have.has(fmt)) continue;
        const out = path.join(tmp, `out.${fmt}`);
        if (o.format === fmt) await copyFile(src, out); // déjà au bon format : le fichier d'origine, intact
        else if (fmt === 'mp3') await convert(src, out, ['-vn', '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '320k']);
        else if (LOSSLESS.has(o.format ?? '')) await convert(src, out, ['-vn', '-map_metadata', '-1', '-c:a', 'pcm_s24le']);
        else throw new Error('WAV impossible depuis une source compressée');
        const f = await putFile(orderId, fmt, fmt, `${base}.${fmt}`, await readFile(out), fmt === 'mp3' ? 'audio/mpeg' : 'audio/wav');
        have.set(fmt, { kind: fmt, ...f });
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  // 2. Certificat : émis une fois (la base refuse toute modification ensuite).
  const audio = o.licence.formats.filter((f) => have.has(f)).map((f) => ({ format: f, filename: have.get(f)!.filename, sha256: have.get(f)!.sha256, size: have.get(f)!.size }));
  const shares = await asService((tx) => tx<{ handle: string; name: string; role: string; pct: number; isOwner: boolean }[]>`
    select p.handle, p.display_name as name, s.role, s.pct::float as pct, s.is_owner as "isOwner"
    from order_shares s join profiles p on p.user_id = s.user_id where s.order_id = ${orderId} order by s.is_owner desc, s.pct desc`);
  const parties = {
    producer: { name: o.sellerName, handle: o.sellerHandle },
    buyer: { email: o.buyerEmail, country: o.country },
    collaborators: shares.map((s) => ({ name: s.name, handle: s.handle, role: s.role, pct: s.pct })),
  };
  await asService((tx) => tx`insert into licence_certificates (order_id, files, source_sha256, parties, terms)
    values (${orderId}, ${tx.json(audio)}, ${o.sourceSha}, ${tx.json(parties)}, ${tx.json(o.licence as never)}) on conflict (order_id) do nothing`);
  const [cert] = await asService((tx) => tx<{ issuedAt: Date; files: typeof audio; sourceSha: string }[]>`
    select issued_at as "issuedAt", files, source_sha256 as "sourceSha" from licence_certificates where order_id = ${orderId}`);

  // 3. Licence (avec le certificat) et facture.
  if (!have.has('licence')) {
    const pdf = await renderPdf({ title: `Licence ${o.licence.name} — ${o.trackTitle}`, footer: `Licence ${o.invoiceNo} · Sonikc` }, [
      { kind: 'title', text: `Licence « ${o.licence.name} »` },
      ...testBanner,
      { kind: 'rows', rows: [
        ['Morceau', o.trackTitle], ['Producteur', `${o.sellerName} (@${o.sellerHandle})`], ['Titulaire', o.buyerEmail],
        ['Date d’achat', dateFr(o.paidAt)], ['Référence', o.invoiceNo],
      ] },
      { kind: 'heading', text: 'Droits accordés' },
      ...(o.licence.description ? [{ kind: 'text' as const, text: o.licence.description, muted: true }] : []),
      ...licenceLines(o.licence).map((l) => ({ kind: 'text' as const, text: `• ${l}` })),
      { kind: 'text', text: 'Le producteur reste l’auteur de la composition. Toute utilisation au-delà de ces limites demande une nouvelle licence.', muted: true },
      { kind: 'heading', text: 'Ayants droit' },
      { kind: 'rows', rows: shares.map((s) => [`${s.name}${s.role ? ` — ${s.role}` : ''}`, `${String(s.pct).replace('.', ',')} % des revenus de la vente`] as [string, string]) },
      { kind: 'heading', text: 'Certificat' },
      { kind: 'rows', rows: [['Émis le', utc(cert.issuedAt)], ['Fichier source (SHA-256)', cert.sourceSha]] },
      ...cert.files.flatMap((f) => [{ kind: 'rows' as const, rows: [[`${FORMAT_LABEL[f.format] ?? 'Fichier'} livré`, f.filename]] as [string, string][] },
        { kind: 'text' as const, text: `SHA-256 : ${f.sha256}`, mono: true }]),
      { kind: 'text', text: `Vérifie l’authenticité : l’empreinte SHA-256 du fichier téléchargé doit être identique à celle inscrite ici. Commande : ${orderUrl(orderId)}`, muted: true },
    ]);
    const f = await putFile(orderId, 'licence', 'pdf', `Licence - ${base}.pdf`, pdf, 'application/pdf');
    have.set('licence', { kind: 'licence', ...f });
  }
  if (!have.has('invoice')) {
    const pdf = await renderPdf({ title: `Facture ${o.invoiceNo}`, footer: `${COMPANY.name} · ${COMPANY.legal}` }, [
      { kind: 'title', text: `Facture ${o.invoiceNo}` },
      ...testBanner,
      { kind: 'rows', rows: [['Émetteur', `${COMPANY.name} — ${COMPANY.address}`], ['N° de TVA', COMPANY.vatNumber], ['Date', dateFr(o.paidAt)],
        ['Client', o.buyerEmail], ['Pays du client', countryName(o.country)]] },
      { kind: 'heading', text: 'Détail' },
      { kind: 'rows', rows: [
        ['Désignation', `Licence « ${o.licence.name} » — ${o.trackTitle} (producteur : ${o.sellerName})`],
        ['Montant HT', euros(o.netCents)],
        [`TVA ${String(o.vatRate).replace('.', ',')} %`, euros(o.vatCents)],
        ['Total TTC', euros(o.grossCents)],
        ['Règlement', `Carte bancaire, le ${dateFr(o.paidAt)}`],
      ] },
      ...(o.vatRate === 0 ? [{ kind: 'text' as const, text: 'TVA non applicable : client établi hors de l’Union européenne.', muted: true }] : []),
      { kind: 'text', text: 'Service fourni par voie électronique : TVA du pays du client (régime du guichet unique OSS).', muted: true },
    ]);
    await putFile(orderId, 'invoice', 'pdf', `Facture ${o.invoiceNo}.pdf`, pdf, 'application/pdf');
  }

  // 4. Fichiers prêts, puis les emails ; « prévenu » seulement après l'envoi réussi (sinon nouvel essai, sans doublon grâce aux clés d'idempotence).
  await asService((tx) => tx`update orders set delivered_at = coalesce(delivered_at, now()) where id = ${orderId}`);
  const url = orderUrl(orderId);
  await sendMail({
    to: o.buyerEmail, tag: 'order', idempotencyKey: `order-buyer-${orderId}`, fromName: `${o.sellerName} via Sonikc`,
    subject: `Ta licence « ${o.licence.name} » pour ${o.trackTitle}`,
    text: `Merci pour ton achat !\n\nTes fichiers, ta licence et ta facture t’attendent ici :\n${url}\n\nGarde ce lien : il te permet de les retélécharger. Tu les retrouves aussi dans « Mes achats » si tu te connectes à Sonikc avec cette adresse.\n\n— Sonikc`,
  });
  const [seller] = await asService((tx) => tx<{ email: string }[]>`select email from users where id = ${o.sellerId}`);
  if (seller) await sendMail({
    to: seller.email, tag: 'sale', idempotencyKey: `order-seller-${orderId}`,
    subject: `Nouvelle vente : ${o.trackTitle} (${o.licence.name})`,
    text: `Bonne nouvelle : ${o.trackTitle} vient d’être acheté (licence ${o.licence.name}, ${euros(o.netCents)} HT).\n\nLe détail et ta part sont dans « Ventes » :\n${url.replace(/\/commande\/.*/, '/app/ventes')}\n\n— Sonikc`,
  });
  await asService((tx) => tx`update orders set buyer_notified_at = now() where id = ${orderId}`);
}

/** Avoir après remboursement (numéroté dans sa propre série), envoyé à l'acheteur. */
export async function creditNote(orderId: string) {
  const o = await loadOrder(orderId);
  if (!o || o.status !== 'refunded' || !o.creditNoteNo || !o.refundedAt) return;
  const have = await existing(orderId);
  if (!have.has('credit_note')) {
    const pdf = await renderPdf({ title: `Avoir ${o.creditNoteNo}`, footer: `${COMPANY.name} · ${COMPANY.legal}` }, [
      { kind: 'title', text: `Avoir ${o.creditNoteNo}` },
      ...testBanner,
      { kind: 'rows', rows: [['Émetteur', `${COMPANY.name} — ${COMPANY.address}`], ['N° de TVA', COMPANY.vatNumber], ['Date', dateFr(o.refundedAt)],
        ['Client', o.buyerEmail], ['Facture annulée', o.invoiceNo]] },
      { kind: 'heading', text: 'Détail' },
      { kind: 'rows', rows: [['Désignation', `Remboursement — licence « ${o.licence.name} », ${o.trackTitle}`], ['Montant HT', `−${euros(o.netCents)}`],
        [`TVA ${String(o.vatRate).replace('.', ',')} %`, `−${euros(o.vatCents)}`], ['Total TTC remboursé', `−${euros(o.grossCents)}`]] },
    ]);
    await putFile(orderId, 'credit_note', 'pdf', `Avoir ${o.creditNoteNo}.pdf`, pdf, 'application/pdf');
  }
  await sendMail({
    to: o.buyerEmail, tag: 'refund', idempotencyKey: `order-refund-${orderId}`,
    subject: `Remboursement : ${o.trackTitle}`,
    text: `Ton achat de la licence « ${o.licence.name} » pour ${o.trackTitle} a été remboursé (${euros(o.grossCents)}). La licence n’est plus valable.\n\nTon avoir est disponible ici :\n${orderUrl(orderId)}\n\n— Sonikc`,
  });
}
