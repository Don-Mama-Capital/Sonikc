'use client';

import { usePlayer } from './PlayerProvider';
import { Waveform } from './Waveform';
import { formatDuration } from '@/lib/format';

export function PlayerBar() {
  const p = usePlayer();
  if (!p.current) return null;
  const progress = p.duration ? p.time / p.duration : 0;
  return (
    <div data-testid="player" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-panel/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-3 py-2 sm:px-6">
        <div className="flex shrink-0 items-center gap-1">
          <button aria-label="Précédent" className="rounded-full p-2 text-mute hover:text-text" onClick={p.prev}>⏮</button>
          <button aria-label={p.playing ? 'Pause' : 'Lecture'} data-testid="player-toggle"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-lg text-ink" onClick={p.toggle}>
            {p.playing ? '❚❚' : '▶'}
          </button>
          <button aria-label="Suivant" className="rounded-full p-2 text-mute hover:text-text" onClick={p.next}>⏭</button>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p data-testid="player-title" className="truncate text-sm font-semibold">{p.current.title}</p>
            <p className="shrink-0 font-mono text-xs text-mute">{formatDuration(p.time * 1000)} / {formatDuration(p.duration * 1000)}</p>
          </div>
          <Waveform peaks={p.current.waveform} progress={progress} onSeek={p.seek} height={28} />
        </div>
        <p className="hidden shrink-0 text-xs text-mute sm:block">{p.index + 1} / {p.queue.length}</p>
      </div>
    </div>
  );
}
