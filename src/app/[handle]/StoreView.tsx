'use client';

import { formatKey } from '@/lib/audio/keys';
import { formatBpm, formatDuration } from '@/lib/format';
import { euros, licenceLines } from '@/lib/licences';
import { usePlayer, type QueueItem } from '@/components/player/PlayerProvider';
import type { storefront } from '@/lib/server/storefront';

type Track = NonNullable<Awaited<ReturnType<typeof storefront>>>['tracks'][number];

export function StoreView({ ownerName, tracks, filtered }: { ownerName: string; tracks: Track[]; filtered: boolean }) {
  const player = usePlayer();
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
