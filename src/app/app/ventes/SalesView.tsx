'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { euros } from '@/lib/licences';
import type { SaleRow } from '@/lib/server/commerce';

type Account = { accountId: string; transfersActive: boolean; detailsSubmitted: boolean } | null;
const SHARE_STATUS: Record<string, string> = {
  scheduled: 'Virement prévu', held: 'En attente de ton compte de reversement', transferred: 'Virée', canceled: 'Annulée (remboursement)', reversed: 'Reprise (remboursement)',
};
const date = (d: string | Date) => new Date(d).toLocaleDateString('fr-FR');

/** Ventes : compte de reversement, ventes et parts reçues, remboursements. */
export function SalesView() {
  const [account, setAccount] = useState<Account | undefined>(undefined);
  const [sales, setSales] = useState<SaleRow[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(async () => {
    const [a, s] = await Promise.all([api<{ account: Account }>('/api/connect'), api<SaleRow[]>('/api/sales')]);
    setAccount(a.account); setSales(s);
  }, []);
  useEffect(() => { load().catch((e) => setMsg({ ok: false, text: e.message })); }, [load]);
  const onboard = async () => {
    setMsg(null);
    try { const { url } = await api<{ url: string }>('/api/connect', { method: 'POST' }); window.location.href = url; }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  const total = (sales ?? []).filter((s) => s.status === 'paid').reduce((a, s) => a + s.myShareCents, 0);
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Ventes</h1>
        <p className="text-sm text-mute">Mode test : aucun argent réel. Chaque part est virée 14 jours après le paiement.</p>
      </header>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? 'text-ok' : 'text-bad'}`}>{msg.text}</p>}

      <section className="card flex flex-wrap items-center justify-between gap-3 p-4" data-testid="payouts">
        <div>
          <h2 className="font-semibold">Reversements</h2>
          <p className="text-sm text-mute" data-testid="payouts-status">
            {account === undefined ? 'Chargement…'
              : account?.transfersActive ? 'Actifs : tes parts sont virées sur ton compte Stripe.'
              : account ? 'Activation à terminer chez Stripe. Tes parts t’attendent, rien n’est perdu.'
              : 'Pas encore activés. Tes parts t’attendent, rien n’est perdu.'}
          </p>
        </div>
        {account !== undefined && !account?.transfersActive && (
          <button className="btn-primary" onClick={onboard} data-testid="onboard">{account ? 'Terminer l’activation' : 'Activer mes reversements'}</button>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Historique</h2>
          {sales && sales.length > 0 && <p className="text-sm text-mute">Tes parts : <span className="text-text">{euros(total)}</span></p>}
        </div>
        {sales?.length === 0 && <p className="card p-6 text-center text-sm text-mute">Aucune vente pour l’instant. Mets un morceau « En vente » depuis son partage.</p>}
        <ul className="space-y-3" data-testid="sales">
          {sales?.map((s) => (
            <li key={s.id} className="card space-y-2 p-4 text-sm" data-testid="sale">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-semibold">{s.trackTitle} <span className="font-normal text-mute">· {s.licenceName}</span></p>
                <p className="text-mute">{date(s.paidAt)} · {s.invoiceNo}</p>
              </div>
              {s.isSeller ? (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-4">
                  <div><dt className="text-xs text-mute">Payé (TTC)</dt><dd>{euros(s.grossCents)}</dd></div>
                  <div><dt className="text-xs text-mute">Prix HT</dt><dd>{euros(s.netCents)}</dd></div>
                  <div><dt className="text-xs text-mute">Commission et frais</dt><dd>−{euros(s.commissionCents + s.feeCents)}</dd></div>
                  <div><dt className="text-xs text-mute">Ta part</dt><dd className="font-semibold" data-testid="my-share">{euros(s.myShareCents)}</dd></div>
                </dl>
              ) : <p>Ta part de collaborateur : <span className="font-semibold">{euros(s.myShareCents)}</span></p>}
              <p className="text-xs text-mute" data-testid="share-status">
                {s.status === 'refunded' ? 'Remboursée' : `${SHARE_STATUS[s.myShareStatus] ?? ''}${s.myShareStatus === 'scheduled' ? ` le ${date(s.transfersDueAt)}` : ''}`}
                {s.isSeller && ` · acheteur : ${s.buyerEmail}`}
              </p>
              {s.isSeller && s.shares.length > 1 && (
                <ul className="text-xs text-mute">{s.shares.map((x) => <li key={x.handle}>@{x.handle} · {String(x.pct).replace('.', ',')} % · {euros(x.amountCents)} · {SHARE_STATUS[x.status]}</li>)}</ul>
              )}
              {s.isSeller && s.status === 'paid' && (
                <button className="text-sm text-mute underline hover:text-text" data-testid="refund" onClick={async () => {
                  if (!confirm(`Rembourser ${euros(s.grossCents)} à ${s.buyerEmail} ? La licence ne sera plus valable. Si ta part a déjà été virée, elle sera reprise.`)) return;
                  setMsg(null);
                  try { await api(`/api/sales/${s.id}/refund`, { method: 'POST' }); await load(); setMsg({ ok: true, text: 'Vente remboursée.' }); }
                  catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
                }}>Rembourser</button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
