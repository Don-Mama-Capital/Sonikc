'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client/api';
import type { Notation } from '@/lib/audio/keys';
import type { getProject, TrackRow } from '@/lib/server/library';
import { TrackList, toQueue } from '@/components/library/TrackList';
import { UploadZone } from '@/components/library/UploadZone';
import { InlinePrompt } from '@/components/library/Prompt';
import { usePlayer } from '@/components/player/PlayerProvider';
import { useRefreshWhileProcessing } from '@/components/library/LibraryView';

type Data = Awaited<ReturnType<typeof getProject>>;

export function ProjectView({ data, notation }: { data: Data; notation: Notation }) {
  const { project, tracks } = data;
  const router = useRouter();
  const player = usePlayer();
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [results, setResults] = useState<TrackRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  useRefreshWhileProcessing(tracks);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); router.refresh(); } catch (e) { setError((e as Error).message); }
  };
  const move = (i: number, d: -1 | 1) => {
    const ids = tracks.map((t) => t.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    act(() => api(`/api/projects/${project.id}/order`, { method: 'PUT', body: { trackIds: ids } }));
  };
  const queue = toQueue(tracks);

  return (
    <div className="space-y-5">
      <Link href={project.folderId ? `/app?folder=${project.folderId}` : '/app'} className="text-sm text-mute hover:text-text">← Bibliothèque</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-2xl font-bold" data-testid="project-title">{project.pinned && <span className="mr-1 text-accent">●</span>}{project.title}</h1>
        <button className="btn-primary" data-testid="play-all" disabled={!queue.length} onClick={() => player.playList(queue)}>▶ Tout écouter</button>
        <button className="btn-ghost" onClick={() => setRenaming(true)}>Renommer</button>
        <button className="btn-ghost" onClick={() => act(() => api(`/api/projects/${project.id}`, { method: 'PATCH', body: { pinned: !project.pinned } }))}>
          {project.pinned ? 'Désépingler' : 'Épingler'}
        </button>
      </div>
      {renaming && (
        <InlinePrompt label="Nom du projet" initial={project.title} submitLabel="Renommer" onCancel={() => setRenaming(false)}
          onSubmit={async (title) => { await api(`/api/projects/${project.id}`, { method: 'PATCH', body: { title } }); setRenaming(false); router.refresh(); }} />
      )}
      <UploadZone projectId={project.id} folderId={project.folderId} />
      <button className="btn-ghost" onClick={() => setAdding((a) => !a)}>+ Ajouter des morceaux de la bibliothèque</button>
      {adding && (
        <div className="card space-y-2 p-3" data-testid="add-tracks">
          <input className="input" placeholder="Chercher un morceau…" autoFocus onChange={async (e) => {
            const q = e.target.value.trim();
            if (q.length < 1) { setResults([]); return; }
            const r = await api<{ tracks: TrackRow[] }>(`/api/library?q=${encodeURIComponent(q)}`);
            setResults(r.tracks.filter((t) => !tracks.some((x) => x.id === t.id)).slice(0, 10));
          }} />
          <ul>
            {results.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-2 py-1 text-sm">
                <span className="truncate">{t.title}</span>
                <button className="btn-ghost py-1" onClick={() => act(async () => {
                  await api(`/api/projects/${project.id}/tracks`, { body: { trackIds: [t.id] } });
                  setResults((r) => r.filter((x) => x.id !== t.id));
                })}>Ajouter</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      <TrackList tracks={tracks} notation={notation} actions={(t, i) => (
        <div className="flex shrink-0 items-center">
          <button aria-label="Monter" disabled={i === 0} className="px-2 text-mute disabled:opacity-20" onClick={() => move(i, -1)}>↑</button>
          <button aria-label="Descendre" disabled={i === tracks.length - 1} className="px-2 text-mute disabled:opacity-20" onClick={() => move(i, 1)}>↓</button>
          <button aria-label={`Retirer ${t.title} du projet`} className="px-2 text-mute hover:text-bad"
            onClick={() => act(() => api(`/api/projects/${project.id}/tracks/${t.id}`, { method: 'DELETE' }))}>✕</button>
        </div>
      )} />
      {!tracks.length && <p className="py-8 text-center text-sm text-mute">Projet vide : dépose des beats ou ajoute-en depuis ta bibliothèque.</p>}
      <button className="text-sm text-bad underline" onClick={() => act(async () => {
        await api(`/api/projects/${project.id}`, { method: 'DELETE' });
        router.push('/app');
      })}>Supprimer le projet (les morceaux restent dans la bibliothèque)</button>
    </div>
  );
}
