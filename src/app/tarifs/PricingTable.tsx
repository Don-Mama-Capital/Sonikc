'use client';

import { useState } from 'react';
import { INCLUDED_EVERYWHERE, LIMIT_LABELS, OFFERS, commissionLabel, euros, offerIds, type Limits } from '@/config/offers';

const keys = Object.keys(LIMIT_LABELS) as (keyof Limits)[];

/** Cartes et comparatif des offres : tout vient du fichier des offres, rien n'est écrit ici. */
export function PricingTable({ loggedIn, current }: { loggedIn: boolean; current?: string }) {
  const [yearly, setYearly] = useState(false);
  const cta = (id: string) => (loggedIn ? `/app/offre?choisir=${id}&periode=${yearly ? 'an' : 'mois'}` : `/login?next=${encodeURIComponent(`/app/offre?choisir=${id}&periode=${yearly ? 'an' : 'mois'}`)}`);
  return (
    <div className="space-y-8">
      <div role="radiogroup" aria-label="Période de paiement" className="inline-flex rounded-full border border-line p-1 text-sm">
        {[false, true].map((y) => (
          <button key={String(y)} role="radio" aria-checked={yearly === y} onClick={() => setYearly(y)}
            className={`rounded-full px-4 py-1.5 ${yearly === y ? 'bg-accent text-ink' : 'text-mute'}`}>{y ? 'À l’année' : 'Au mois'}</button>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-3" data-testid="offers">
        {offerIds.map((id) => {
          const o = OFFERS[id];
          const price = yearly ? o.priceYearCents : o.priceMonthCents;
          const monthsSaved = o.priceMonthCents ? 12 - o.priceYearCents / o.priceMonthCents : 0;
          return (
            <section key={id} className={`card flex flex-col gap-4 p-5 ${current === id ? 'ring-2 ring-accent' : ''}`} data-testid={`offer-${id}`}>
              <div>
                <h2 className="text-xl font-bold">{o.name}</h2>
                <p className="text-sm text-mute">{o.tagline}</p>
              </div>
              <p>
                <span className="text-3xl font-black" data-testid="price">{euros(price)}</span>
                {price > 0 && <span className="text-sm text-mute"> TTC / {yearly ? 'an' : 'mois'}</span>}
                {yearly && monthsSaved >= 1 && <span className="ml-2 text-xs text-ok">{Math.round(monthsSaved)} mois offerts</span>}
              </p>
              <ul className="space-y-1 text-sm">
                <li className="font-medium">{commissionLabel(o.commissionPct)}</li>
                {keys.map((k) => <li key={k}><span className="text-mute">{LIMIT_LABELS[k].title} :</span> {LIMIT_LABELS[k].value(o.limits[k] as never)}</li>)}
              </ul>
              <div className="mt-auto">
                {current === id ? <p className="text-center text-sm text-mute">Ton offre actuelle</p>
                  : <a className={price ? 'btn-primary block text-center' : 'btn-ghost block text-center'} href={price ? cta(id) : loggedIn ? '/app' : '/login'}>
                    {price ? (o.trialDays ? `Essayer ${o.trialDays} jours gratuits` : `Choisir ${o.name}`) : 'Commencer'}
                  </a>}
              </div>
            </section>
          );
        })}
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Inclus dans toutes les offres</h2>
        <ul className="grid gap-1 text-sm sm:grid-cols-2">{INCLUDED_EVERYWHERE.map((x) => <li key={x}>✓ {x}</li>)}</ul>
      </section>

      <section className="space-y-2 overflow-x-auto">
        <h2 className="text-lg font-semibold">Comparatif</h2>
        <p className="text-xs text-mute sm:hidden">Fais glisser le tableau pour voir toutes les offres.</p>
        <table className="w-full min-w-[32rem] text-left text-sm" data-testid="compare">
          <thead><tr><th className="py-2 pr-3 font-medium text-mute">Ce qui change</th>{offerIds.map((id) => <th key={id} className="py-2 pr-3">{OFFERS[id].name}</th>)}</tr></thead>
          <tbody className="divide-y divide-line">
            <tr><td className="py-2 pr-3 text-mute">Commission sur tes ventes</td>{offerIds.map((id) => <td key={id} className="py-2 pr-3">{OFFERS[id].commissionPct} %</td>)}</tr>
            {keys.map((k) => (
              <tr key={k}><td className="py-2 pr-3 text-mute">{LIMIT_LABELS[k].title}</td>
                {offerIds.map((id) => <td key={id} className="py-2 pr-3">{LIMIT_LABELS[k].value(OFFERS[id].limits[k] as never)}</td>)}</tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-mute">Prix TTC. Si tu passes à une offre plus petite, rien n’est supprimé : seuls les ajouts au-delà des nouvelles limites sont bloqués.</p>
      </section>
    </div>
  );
}
