'use client';

import { useState } from 'react';
import { formatKey } from '@/lib/audio/keys';
import { formatBpm, formatDuration } from '@/lib/format';
import { euros, licenceLines } from '@/lib/licences';
import { usePlayer, type QueueItem } from '@/components/player/PlayerProvider';
import type { storefront } from '@/lib/server/storefront';

type Track = NonNullable<Awaited<ReturnType<typeof storefront>>>['tracks'][number];

export function StoreView({ ownerName, tracks, filtered, canBuy, countries, buyerEmail }:
  { ownerName: string; tracks: Track[]; filtered: boolean; canBuy: boolean; countries: { code: string; name: string }[]; buyerEmail: string | null }) {
  const player = usePlayer();
  const [buying, setBuying] = useState<{ trackId: string; templateId: string } | null>(null);
  if (!tracks.length) {
    return <p className="card p-6 text-center text-sm text-mute" data-testid="store-empty">{filtered ? 'Aucun morceau ne correspond à ces filtres.' : 'Aucun morceau public pour l’instant.'}</p>;
  }
  const queue: QueueItem[] = tracks.map((t) => ({ id: t.id, title: t.title, url: t.audioUrl, waveform: t.waveform, durationMs: t.durationMs, subtitle: ownerName }));
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel" data-testid="store-tracks">
      {tracks.map((t, i) => {
        const isCurrent = player.current?.id === t.id;
        const meta = [formatBpm(t.bpm), formatKey(t.keyPc, t.keyMode, 'auto'), formatDuration(t.durationMs)].filter(Boolean).join(' · ');
        return (
          <li key={t.id} data-testid="store-track" className={isCurrent ? 'bg-panel-2' : ''}>
            <div className="flex items-center gap-3 px-3 py-2.5">
              <button className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-ink" aria-label={`${isCurrent && player.playing ? 'Pause' : 'Écouter'} ${t.title}`}
                onClick={() => (isCurrent ? player.toggle() : player.playList(queue, i))}>
                {isCurrent && player.playing ? '❚❚' : '▶'}
              </button>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{t.title}</p>
                {meta && <p className="text-xs text-mute">{meta}</p>}
              </div>
              <span className="shrink-0 text-right text-sm" data-testid="store-price">
                {t.soldExclusive ? <span className="text-mute">Exclusivité vendue</span>
                  : t.fromGrossCents !== null ? <>dès <span className="font-semibold">{euros(t.fromGrossCents)}</span></>
                  : null}
              </span>
            </div>
            {t.offers.length > 0 && (
              <details className="px-3 pb-3">
                <summary className="cursor-pointer text-sm text-mute hover:text-text">Voir les licences</summary>
                <ul className="mt-2 grid gap-2 sm:grid-cols-2" data-testid="licences">
                  {t.offers.map((o) => (
                    <li key={o.id} className="rounded-xl border border-line p-3" data-testid="licence">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="font-semibold">{o.name}</p>
                        <p className="font-semibold">{euros(o.grossFrCents)}</p>
                      </div>
                      {o.description && <p className="mt-1 text-xs text-mute">{o.description}</p>}
                      <ul className="mt-2 space-y-0.5 text-xs">
                        {licenceLines(o).map((l) => <li key={l}>{l}</li>)}
                      </ul>
                      {canBuy && (buying?.trackId === t.id && buying.templateId === o.id
                        ? <BuyForm trackId={t.id} templateId={o.id} countries={countries} email={buyerEmail} onCancel={() => setBuying(null)} />
                        : <button className="btn-primary mt-3 w-full" data-testid="buy" onClick={() => setBuying({ trackId: t.id, templateId: o.id })}>Acheter</button>)}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-mute">Prix TTC pour la France. Le montant final dépend de ton pays.</p>
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function BuyForm({ trackId, templateId, countries, email, onCancel }:
  { trackId: string; templateId: string; countries: { code: string; name: string }[]; email: string | null; onCancel: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form className="mt-3 space-y-2" data-testid="buy-form" onSubmit={async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      setBusy(true); setError(null);
      const res = await fetch('/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trackId, templateId, email: fd.get('email'), country: fd.get('country') }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) { window.location.href = data.url; return; }
      setBusy(false); setError(data.error ?? 'Le paiement n’a pas pu commencer. Réessaie.');
    }}>
      <label className="block text-xs"><span className="text-mute">Ton email (fichiers et facture)</span>
        <input className="input mt-1" name="email" type="email" required autoComplete="email" defaultValue={email ?? ''} /></label>
      <label className="block text-xs"><span className="text-mute">Ton pays (pour la TVA)</span>
        <select className="input mt-1" name="country" required defaultValue="FR">
          {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
        </select></label>
      {error && <p role="alert" className="text-xs text-bad">{error}</p>}
      <div className="flex gap-2">
        <button className="btn-primary flex-1" type="submit" disabled={busy}>{busy ? 'Ouverture…' : 'Payer'}</button>
        <button className="btn-ghost" type="button" onClick={onCancel}>Annuler</button>
      </div>
      <p className="text-xs text-mute">Paiement sécurisé par Stripe. Le prix TTC final dépend de ton pays.</p>
    </form>
  );
}
