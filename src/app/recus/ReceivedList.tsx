'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatDuration } from '@/lib/format';
import { usePlayer, type QueueItem } from '@/components/player/PlayerProvider';
import type { Received } from '@/lib/server/saves';

export function ReceivedList({ items }: { items: Received[] }) {
  const router = useRouter();
  const player = usePlayer();
  const remove = async (linkId: string) => { await fetch(`/api/received/${linkId}`, { method: 'DELETE' }); router.refresh(); };
  if (!items.length) {
    return <p className="card p-4 text-sm text-mute" data-testid="received-empty">Rien pour l’instant. Sur une page d’écoute, clique sur « Enregistrer dans mes reçus » pour retrouver le partage ici.</p>;
  }
  return (
    <ul className="space-y-4" data-testid="received">
      {items.map((it) => {
        if (!it.available) {
          return (
            <li key={it.id} className="card flex items-center justify-between gap-3 p-4 text-sm" data-testid="received-item" data-available="false">
              <span className="text-mute">{it.reason === 'password' ? 'Partage protégé : son mot de passe a changé.' : 'Ce partage n’est plus disponible : le producteur l’a retiré.'}</span>
              <button className="shrink-0 text-mute underline hover:text-text" onClick={() => remove(it.linkId)}>Retirer</button>
            </li>
          );
        }
        const visible = it.view.tracks.filter((t) => !t.hiddenForListeners);
        const queue: QueueItem[] = visible.map((t) => ({
          id: t.id, title: t.title, url: t.audioUrl, waveform: t.waveform, durationMs: t.durationMs, subtitle: it.view.ownerName,
          listen: { token: it.token, trackId: t.id },
        }));
        return (
          <li key={it.id} className="card space-y-3 p-4" data-testid="received-item" data-available="true">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="truncate font-semibold" data-testid="received-title">{it.view.title}</h2>
                <p className="text-xs text-mute">par {it.view.ownerName || 'un producteur'} · enregistré le {new Date(it.savedAt).toLocaleDateString('fr-FR')}</p>
              </div>
              <div className="flex shrink-0 gap-3 text-sm">
                <Link className="text-mute underline hover:text-text" href={`/s/${it.token}`}>Ouvrir</Link>
                <button className="text-mute underline hover:text-text" onClick={() => remove(it.linkId)}>Retirer</button>
              </div>
            </div>
            <ul className="divide-y divide-line">
              {visible.map((t, i) => {
                const isCurrent = player.current?.id === t.id;
                return (
                  <li key={t.id} className="flex items-center gap-3 py-2" data-testid="received-track">
                    <button className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-ink" aria-label={`${isCurrent && player.playing ? 'Pause' : 'Écouter'} ${t.title}`}
                      onClick={() => (isCurrent ? player.toggle() : player.playList(queue, i))}>
                      {isCurrent && player.playing ? '❚❚' : '▶'}
                    </button>
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                    <span className="shrink-0 font-mono text-xs text-mute">{formatDuration(t.durationMs)}</span>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-mute">{it.view.ownerName || 'Le producteur'} voit les écoutes de ce partage.</p>
          </li>
        );
      })}
    </ul>
  );
}
