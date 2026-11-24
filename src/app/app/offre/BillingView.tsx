'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/client/api';
import { formatBytes } from '@/lib/format';
import { LIMIT_LABELS, OFFERS, euros, isOfferId } from '@/config/offers';
import { COUNTRIES } from '@/config/vat';
import { PricingTable } from '@/app/tarifs/PricingTable';
import type { billingOverview } from '@/lib/server/billing';

type Overview = Awaited<ReturnType<typeof billingOverview>>;
const date = (d: string | null) => (d ? new Date(d).toLocaleDateString('fr-FR') : '');
const STATUS: Record<string, string> = { trialing: 'Essai gratuit', active: 'Actif', past_due: 'Paiement en retard (Stripe réessaie)', canceled: 'Terminé', unpaid: 'Impayé', incomplete: 'Paiement à terminer' };

function Meter({ label, used, max, fmt = (n: number) => n.toLocaleString('fr-FR'), maxLabel }:
  { label: string; used: number; max: number | null; fmt?: (n: number) => string; maxLabel?: string }) {
  const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return (
    <div className="space-y-1" data-testid="meter">
      <div className="flex justify-between text-sm"><span className="text-mute">{label}</span><span>{fmt(used)}{max !== null ? ` / ${maxLabel ?? fmt(max)}` : ''}</span></div>
      {max !== null && <div className="h-1.5 rounded-full bg-line"><div className={`h-1.5 rounded-full ${pct >= 100 ? 'bg-bad' : 'bg-accent'}`} style={{ width: `${pct}%` }} /></div>}
    </div>
  );
}

/** « Mon offre » : offre en vigueur, abonnement, consommation, changement d'offre. */
export function BillingView() {
  const params = useSearchParams();
  const [o, setO] = useState<Overview | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const wanted = params.get('choisir');
  const [country, setCountry] = useState('FR');
  const load = useCallback(async () => setO(await api<Overview>('/api/billing')), []);
  useEffect(() => { load().catch((e) => setMsg({ ok: false, text: e.message })); }, [load]);
  // Retour de Stripe : l'offre change dès que le webhook est traité ; on relit quelques secondes.
  useEffect(() => {
    if (params.get('abonnement') !== 'ok') return;
    setMsg({ ok: true, text: 'Merci ! Ton offre est mise à jour.' });
    const t = setInterval(() => load().catch(() => {}), 2000);
    const stop = setTimeout(() => clearInterval(t), 30_000);
    return () => { clearInterval(t); clearTimeout(stop); };
  }, [params, load]);
  if (!o) return <p className="text-sm text-mute">Chargement…</p>;
  const go = async (path: string, body?: unknown) => {
    setBusy(true); setMsg(null);
    try { const { url } = await api<{ url: string }>(path, { method: 'POST', body }); window.location.href = url; }
    catch (e) { setBusy(false); setMsg({ ok: false, text: (e as Error).message }); }
  };
  const sub = o.subscription;
  const hasSub = sub?.status && ['trialing', 'active', 'past_due'].includes(sub.status);
  const choice = wanted && isOfferId(wanted) && wanted !== 'free' && !hasSub ? wanted : null;
  const period = params.get('periode') === 'an' ? 'year' : 'month';
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-bold">Mon offre</h1>
        <p className="text-sm text-mute">Mode test : aucun paiement réel.</p>
      </header>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? 'text-ok' : 'text-bad'}`}>{msg.text}</p>}

      <section className="card space-y-4 p-5" data-testid="current-offer">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-bold" data-testid="offer-name">{o.offerName}</h2>
          {hasSub && <button className="btn-ghost" disabled={busy} data-testid="portal" onClick={() => go('/api/billing/portal')}>Gérer mon abonnement</button>}
        </div>
        {sub?.status && (
          <p className="text-sm" data-testid="sub-status">
            {STATUS[sub.status] ?? sub.status}
            {sub.status === 'trialing' && sub.trialEnd && ` jusqu’au ${date(sub.trialEnd)}`}
            {sub.status === 'active' && sub.currentPeriodEnd && (sub.cancelAtPeriodEnd ? ` · se termine le ${date(sub.currentPeriodEnd)}` : ` · renouvelé le ${date(sub.currentPeriodEnd)}`)}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Meter label={LIMIT_LABELS.tracks.title} used={o.usage.tracks} max={o.limits.tracks} />
          <Meter label={LIMIT_LABELS.storageGb.title} used={o.usage.storageBytes} max={o.limits.storageBytes}
            fmt={(n) => (n ? formatBytes(n) : '0 Mo')} maxLabel={LIMIT_LABELS.storageGb.value(o.limits.storageGb)} />
          <Meter label={LIMIT_LABELS.contacts.title} used={o.usage.contacts} max={o.limits.contacts} />
          <Meter label={`${LIMIT_LABELS.emailsPerMonth.title} (ce mois-ci)`} used={o.usage.emailsThisMonth} max={o.limits.emailsPerMonth} />
        </div>
        <p className="text-xs text-mute">Au-delà d’une limite, rien n’est supprimé : seuls les ajouts sont bloqués. Tes morceaux restent écoutables et téléchargeables.</p>
      </section>

      {wanted && hasSub && wanted !== o.plan && isOfferId(wanted) && (
        <p className="card p-4 text-sm" data-testid="use-portal">Tu as déjà un abonnement : pour passer à {OFFERS[wanted].name}, utilise « Gérer mon abonnement ».</p>
      )}
      {choice && (
        <section className="card space-y-3 p-5" data-testid="subscribe">
          <h2 className="text-lg font-semibold">Passer à {OFFERS[choice].name}</h2>
          <p className="text-sm">
            {euros(period === 'year' ? OFFERS[choice].priceYearCents : OFFERS[choice].priceMonthCents)} TTC / {period === 'year' ? 'an' : 'mois'}
            {!sub?.trialUsed && OFFERS[choice].trialDays > 0 && ` · ${OFFERS[choice].trialDays} jours gratuits, sans carte`}
          </p>
          <label className="block text-sm"><span className="text-mute">Ton pays (pour la TVA)</span>
            <select className="input mt-1" value={country} onChange={(e) => setCountry(e.target.value)}>
              {COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select></label>
          <button className="btn-primary" disabled={busy} data-testid="subscribe-go" onClick={() => go('/api/billing/checkout', { plan: choice, period, country })}>
            {busy ? 'Ouverture…' : 'Continuer vers le paiement'}
          </button>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Toutes les offres</h2>
        <PricingTable loggedIn current={o.plan} />
      </section>
    </div>
  );
}
