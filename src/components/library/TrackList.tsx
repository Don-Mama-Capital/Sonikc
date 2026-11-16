'use client';

import Link from 'next/link';
import { usePlayer, type QueueItem } from '../player/PlayerProvider';
import { formatKey, type Notation } from '@/lib/audio/keys';
import { formatBpm, formatDuration } from '@/lib/format';
import type { TrackRow } from '@/lib/server/library';

export function toQueue(tracks: TrackRow[]): QueueItem[] {
  return tracks.filter((t) => t.version?.previewUrl).map((t) => ({
    id: t.id, title: t.title, url: t.version!.previewUrl!, waveform: t.version!.waveform, durationMs: t.version!.durationMs,
  }));
}

export function TrackList({ tracks, notation, actions }: {
  tracks: TrackRow[]; notation: Notation; actions?: (t: TrackRow, i: number) => React.ReactNode;
}) {
  const player = usePlayer();
  const queue = toQueue(tracks);
  if (!tracks.length) return null;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel" data-testid="track-list">
      {tracks.map((t, i) => {
        const ready = Boolean(t.version?.previewUrl);
        const isCurrent = player.current?.id === t.id;
        const status = t.version?.status;
        const key = formatKey(t.keyPc, t.keyMode, notation);
        return (
          <li key={t.id} data-testid="track-row" data-title={t.title} className={`flex items-center gap-3 px-3 py-2.5 ${isCurrent ? 'bg-panel-2' : ''}`}>
            <button
              aria-label={`Écouter ${t.title}`}
              data-testid="play-track"
              disabled={!ready}
              onClick={() => (isCurrent ? player.toggle() : player.playList(queue, queue.findIndex((q) => q.id === t.id)))}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line text-sm disabled:opacity-30"
            >
              {isCurrent && player.playing ? '❚❚' : '▶'}
            </button>
            <div className="min-w-0 flex-1">
              <Link href={`/app/tracks/${t.id}`} className="block truncate font-medium hover:underline">
                {t.pinned && <span className="mr-1 text-accent" title="Épinglé">●</span>}{t.title}
              </Link>
              <p className="truncate text-xs text-mute">
                {status === 'uploading' && 'Envoi en cours…'}
                {status === 'processing' && <span data-testid="processing">Analyse en cours…</span>}
                {status === 'failed' && <span className="text-bad">{t.version?.error ?? 'Échec du traitement.'}</span>}
                {status === 'ready' && [formatBpm(t.bpm), key, formatDuration(t.version?.durationMs), t.versionCount > 1 ? `${t.versionCount} versions` : null, ...t.tags.map((g) => `#${g}`)].filter(Boolean).join(' · ')}
              </p>
            </div>
            {actions?.(t, i)}
          </li>
        );
      })}
    </ul>
  );
}
