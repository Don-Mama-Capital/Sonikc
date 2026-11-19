import { notFound } from 'next/navigation';
import { orderFilePath, orderView, parseOrderToken } from '@/lib/server/commerce';
import { euros, FORMAT_LABEL, licenceLines, type LicenceTerms } from '@/lib/licences';
import { formatBytes } from '@/lib/format';
import { EU_VAT } from '@/config/vat';
import { AutoRefresh } from './AutoRefresh';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Ta commande', robots: { index: false, follow: false } };

const KIND_LABEL: Record<string, string> = { licence: 'Licence et certificat (PDF)', invoice: 'Facture (PDF)', credit_note: 'Avoir (PDF)' };
const ORDER = ['wav', 'mp3', 'licence', 'invoice', 'credit_note'];

/** Page de commande : accessible par le lien signé reçu par email, sans compte. */
export default async function OrderPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ paye?: string }> }) {
  const { token } = await params;
  const { paye } = await searchParams;
  const id = parseOrderToken(token);
  if (!id) notFound();
  const o = await orderView(id);
  if (!o || o.status === 'expired') notFound();
  const lic = o.licence as LicenceTerms & { name: string };
  const files = [...o.files].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))
    .filter((f) => o.status === 'paid' || f.kind === 'invoice' || f.kind === 'credit_note');
  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 pb-20 pt-8 sm:px-6">
      <p className="text-sm font-semibold uppercase tracking-[0.3em] text-accent">Sonikc</p>
      {o.status === 'pending' && (
        <section className="card space-y-2 p-5" data-testid="order-pending">
          <h1 className="text-xl font-bold">{paye ? 'Paiement reçu, on prépare tes fichiers…' : 'Paiement en attente'}</h1>
          <p className="text-sm text-mute">Cette page se met à jour toute seule. Tu recevras aussi un email.</p>
          <AutoRefresh />
        </section>
      )}
      {o.status !== 'pending' && (
        <>
          <header className="space-y-1">
            <h1 className="text-2xl font-bold" data-testid="order-title">{o.trackTitle}</h1>
            <p className="text-sm text-mute">Licence « {lic.name} » · par {o.sellerName}</p>
            {o.status === 'refunded' && <p className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-sm" data-testid="order-refunded">Commande remboursée : la licence n’est plus valable.</p>}
            {o.status === 'refunded' && !o.files.some((f) => f.kind === 'credit_note') && <AutoRefresh />}
          </header>
          <section className="card space-y-3 p-5">
            <h2 className="font-semibold">Tes fichiers</h2>
            {o.status === 'paid' && !o.deliveredAt && <><p className="text-sm text-mute" data-testid="order-preparing">Préparation des fichiers… (moins d’une minute)</p><AutoRefresh /></>}
            <ul className="divide-y divide-line" data-testid="order-files">
              {files.map((f) => (
                <li key={f.kind} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{FORMAT_LABEL[f.kind] ?? KIND_LABEL[f.kind] ?? 'Fichier'}</span>
                    <span className="block truncate text-xs text-mute">{f.filename} · {formatBytes(f.sizeBytes)}</span>
                  </span>
                  <a className="btn-ghost shrink-0" href={orderFilePath(o.id, f.kind)} data-testid={`file-${f.kind}`}>Télécharger</a>
                </li>
              ))}
            </ul>
          </section>
          {o.status === 'paid' && (
            <section className="card space-y-2 p-5 text-sm">
              <h2 className="font-semibold">Ce que tu peux faire</h2>
              <ul className="space-y-0.5">{licenceLines(lic).map((l) => <li key={l}>{l}</li>)}</ul>
            </section>
          )}
          {o.certificate && o.status === 'paid' && (
            <section className="card space-y-2 p-5 text-sm" data-testid="certificate">
              <h2 className="font-semibold">Certificat</h2>
              <p className="text-mute">Émis le {o.certificate.issuedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC. L’empreinte SHA-256 de chaque fichier téléchargé doit être identique :</p>
              <ul className="space-y-1">{o.certificate.files.map((f) => (
                <li key={f.format}><span className="text-mute">{FORMAT_LABEL[f.format] ?? 'Fichier'} :</span> <code className="break-all font-mono text-xs">{f.sha256}</code></li>
              ))}</ul>
            </section>
          )}
          <section className="card p-5 text-sm">
            <dl className="grid grid-cols-2 gap-y-1">
              <dt className="text-mute">Facture</dt><dd>{o.invoiceNo}</dd>
              {o.creditNoteNo && <><dt className="text-mute">Avoir</dt><dd>{o.creditNoteNo}</dd></>}
              <dt className="text-mute">Prix HT</dt><dd>{euros(o.netCents)}</dd>
              <dt className="text-mute">TVA {String(o.vatRate).replace('.', ',')} % ({EU_VAT[o.country]?.name ?? 'hors UE'})</dt><dd>{euros(o.vatCents)}</dd>
              <dt className="text-mute">Total payé</dt><dd className="font-semibold">{euros(o.grossCents)}</dd>
            </dl>
          </section>
          <p className="text-xs text-mute">Garde ce lien : il te permet de retélécharger tes fichiers. Connecte-toi à Sonikc avec {o.buyerEmail} pour retrouver tes achats dans « Mes achats ».</p>
        </>
      )}
    </main>
  );
}
