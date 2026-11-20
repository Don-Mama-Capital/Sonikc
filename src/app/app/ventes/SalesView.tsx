'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { euros } from '@/lib/licences';
import type { SaleRow, SplitInvite } from '@/lib/server/commerce';
import { COUNTRIES, OUTSIDE_EU } from '@/config/vat';

type Account = { accountId: string; transfersActive: boolean; detailsSubmitted: boolean } | null;
const SHARE_STATUS: Record<string, string> = {
  scheduled: 'Virement prévu', held: 'En attente de ton compte de reversement', disputed: 'Bloquée : litige bancaire en cours', transferred: 'Virée', canceled: 'Annulée (remboursement)', reversed: 'Reprise (remboursement)',
};
const date = (d: string | Date) => new Date(d).toLocaleDateString('fr-FR');

/** Ventes : compte de reversement, ventes et parts reçues, remboursements. */
export function SalesView() {
  const [account, setAccount] = useState<Account | undefined>(undefined);
  const [sales, setSales] = useState<SaleRow[] | null>(null);
  const [invites, setInvites] = useState<SplitInvite[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(async () => {
    const [a, s, i] = await Promise.all([api<{ account: Account }>('/api/connect'), api<SaleRow[]>('/api/sales'), api<SplitInvite[]>('/api/splits')]);
    setAccount(a.account); setSales(s); setInvites(i);
  }, []);
  useEffect(() => { load().catch((e) => setMsg({ ok: false, text: e.message })); }, [load]);
  const [country, setCountry] = useState('FR');
  const answer = async (i: SplitInvite, accept: boolean) => {
    setMsg(null);
    try { await api(`/api/splits/${i.trackId}`, { method: 'POST', body: { accept, pct: i.pct, role: i.role, invitedAt: i.invitedAt } }); }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    await load();
  };
  const onboard = async () => {
    setMsg(null);
    try { const { url } = await api<{ url: string }>('/api/connect', { method: 'POST', body: { country } }); window.location.href = url; }
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
          <div className="flex flex-wrap items-center gap-2">
            {!account && (
              <label className="text-sm"><span className="sr-only">Pays de ton compte bancaire</span>
                <select className="input" value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Pays de ton compte bancaire">
                  {COUNTRIES.filter((c) => c.code !== OUTSIDE_EU).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                </select></label>
            )}
            <button className="btn-primary" onClick={onboard} data-testid="onboard">{account ? 'Terminer l’activation' : 'Activer mes reversements'}</button>
          </div>
        )}
      </section>

      {invites.length > 0 && (
        <section className="space-y-2" data-testid="collabs">
          <h2 className="text-lg font-semibold">Collaborations</h2>
          <ul className="space-y-2">
            {invites.map((i) => (
              <li key={i.trackId} className="card flex flex-wrap items-center justify-between gap-3 p-4 text-sm" data-testid="collab">
                <span className="min-w-0">
                  <span className="block font-medium">{i.trackTitle} <span className="font-normal text-mute">· par {i.ownerName} (@{i.ownerHandle})</span></span>
                  <span className="block text-mute">
                    {i.status === 'pending' ? `Proposition : ${String(i.pct).replace('.', ',')} % de chaque vente${i.role ? ` · ${i.role}` : ''} · s’applique aux ventes faites après ton accord`
                      : `${String(i.pct).replace('.', ',')} % de chaque vente${i.role ? ` · ${i.role}` : ''}`}
                    {i.acceptedPct != null && ` · en vigueur : ${String(i.acceptedPct).replace('.', ',')} %`}</span>
                </span>
                <span className="flex gap-2">
                  {i.status === 'pending' && <>
                    <button className="btn-primary" data-testid="accept" onClick={() => answer(i, true)}>Accepter</button>
                    <button className="btn-ghost" data-testid="decline" onClick={() => {
                      if (confirm(`Refuser ${String(i.pct).replace('.', ',')} % des ventes de « ${i.trackTitle} » ?${i.acceptedPct != null ? ' Ta part actuelle reste en vigueur.' : ''}`)) answer(i, false);
                    }}>Refuser</button>
                  </>}
                  {i.acceptedPct != null && (
                    <button className="text-sm text-mute underline hover:text-text" data-testid="withdraw" onClick={async () => {
                      if (!confirm(`Te retirer de « ${i.trackTitle} » ? Ta part ne s’appliquera plus aux ventes suivantes. Ce qui t’est déjà dû reste à toi.`)) return;
                      await api(`/api/splits/${i.trackId}`, { method: 'DELETE' }); await load();
                    }}>Me retirer</button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

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
              {s.isSeller && s.status === 'paid' && !s.refundable && (
                <p className="text-xs text-mute">Virement parti : pour rembourser, écris au support de Sonikc.</p>
              )}
              {s.isSeller && s.refundable && (
                <button className="text-sm text-mute underline hover:text-text" data-testid="refund" onClick={async () => {
                  if (!confirm(`Rembourser ${euros(s.grossCents)} à ${s.buyerEmail} ? La licence ne sera plus valable.`)) return;
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
