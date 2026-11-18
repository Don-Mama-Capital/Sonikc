'use client';

import { formatKey } from '@/lib/audio/keys';
import { formatBpm, formatDuration } from '@/lib/format';
import { usePlayer, type QueueItem } from '@/components/player/PlayerProvider';
import type { loadShared } from '@/lib/server/viewer';

type View = NonNullable<Awaited<ReturnType<typeof loadShared>>>;

export function SharedView({ token, view }: { token: string; view: View }) {
  const player = usePlayer();
  const visible = view.tracks.filter((t) => view.isOwner || !t.hiddenForListeners);
  const queue: QueueItem[] = visible.map((t) => ({
    id: t.id, title: t.title, url: t.audioUrl, waveform: t.waveform, durationMs: t.durationMs, subtitle: view.ownerName,
    listen: view.isOwner ? undefined : { token, trackId: t.id },
  }));
  return (
    <div className="space-y-5">
      {view.isOwner && (
        <p className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-sm" data-testid="owner-preview">
          Aperçu propriétaire : tes écoutes ne sont pas comptées. Les morceaux marqués « masqué » n’apparaissent pas pour tes auditeurs.
        </p>
      )}
      <header className="space-y-1">
        <h1 className="text-2xl font-bold" data-testid="shared-title">{view.title}</h1>
        <p className="text-sm text-mute">par <span className="text-text">{view.ownerName || 'un producteur'}</span> · {visible.length} morceau{visible.length > 1 ? 'x' : ''}</p>
      </header>
      {queue.length > 1 && <button className="btn-primary" onClick={() => player.playList(queue)}>▶ Tout écouter</button>}
      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel" data-testid="shared-tracks">
        {visible.map((t, i) => {
          const isCurrent = player.current?.id === t.id;
          const meta = [formatBpm(t.bpm), formatKey(t.keyPc, t.keyMode, 'auto')].filter(Boolean).join(' · ');
          return (
            <li key={t.id} data-testid="shared-track" className={`flex items-center gap-3 px-3 py-2.5 ${isCurrent ? 'bg-panel-2' : ''}`}>
              <button className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-ink" aria-label={`${isCurrent && player.playing ? 'Pause' : 'Écouter'} ${t.title}`}
                onClick={() => (isCurrent ? player.toggle() : player.playList(queue, i))}>
                {isCurrent && player.playing ? '❚❚' : '▶'}
              </button>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{t.title}{view.isOwner && t.hiddenForListeners && <span className="ml-2 rounded bg-panel-2 px-1.5 py-0.5 text-xs text-mute">masqué</span>}</p>
                {meta && <p className="text-xs text-mute">{meta}</p>}
              </div>
              <span className="shrink-0 font-mono text-xs text-mute">{formatDuration(t.durationMs)}</span>
              {t.allowDownload && (
                <a className="shrink-0 text-sm text-mute underline hover:text-text" href={`/api/s/${token}/download/${t.versionId}`} aria-label={`Télécharger ${t.title}`}>
                  Télécharger
                </a>
              )}
            </li>
          );
        })}
      </ul>
      {!visible.length && <p className="text-sm text-mute">Aucun morceau à écouter pour l’instant.</p>}
      <p className="text-xs text-mute" data-testid="tracking-notice">
        {view.ownerName || 'Le producteur'} voit les écoutes de ce lien : date, morceaux écoutés et durée d’écoute. Si tu es connecté, ton nom de compte apparaît ; sinon tu restes anonyme.
      </p>
    </div>
  );
}
