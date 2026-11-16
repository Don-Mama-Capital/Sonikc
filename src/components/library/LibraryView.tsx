'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/client/api';
import type { Notation } from '@/lib/audio/keys';
import type { TrackRow } from '@/lib/server/library';
import { TrackList } from './TrackList';
import { UploadZone } from './UploadZone';
import { InlinePrompt } from './Prompt';
import { MoveDialog } from './MoveDialog';

type Data = {
  folderId: string | null;
  crumbs: { id: string; name: string }[];
  folders: { id: string; name: string; itemCount: number }[];
  projects: { id: string; title: string; pinned: boolean; trackCount: number }[];
  tracks: TrackRow[];
  searching: boolean;
};

/** Rafraîchit la page tant qu'un morceau est en cours d'envoi ou d'analyse. */
export function useRefreshWhileProcessing(tracks: TrackRow[]) {
  const router = useRouter();
  const pending = tracks.some((t) => t.version?.status === 'processing' || t.version?.status === 'uploading');
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(id);
  }, [pending, router]);
}

export function LibraryView({ data, notation }: { data: Data; notation: Notation }) {
  const router = useRouter();
  const sp = useSearchParams();
  const [mode, setMode] = useState<null | 'folder' | 'project' | { rename: string; name: string }>(null);
  const [moving, setMoving] = useState<null | { kind: 'track' | 'folder'; id: string; title: string }>(null);
  const [error, setError] = useState<string | null>(null);
  useRefreshWhileProcessing(data.tracks);

  const here = (params: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    return `/app${q.size ? `?${q}` : ''}`;
  };
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); router.refresh(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="space-y-5">
      <form className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_6rem_6rem_7rem_7rem_auto]" data-testid="filters"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const get = (k: string) => (String(f.get(k) ?? '').trim() || undefined);
          router.push(here({ q: get('q'), bpmMin: get('bpmMin'), bpmMax: get('bpmMax'), key: get('key'), tag: get('tag')?.replace(/^#/, '') }));
        }}>
        <input name="q" className="input col-span-2 sm:col-span-1" placeholder="Rechercher un titre ou un tag" defaultValue={sp.get('q') ?? ''} aria-label="Recherche" />
        <input name="bpmMin" className="input" inputMode="numeric" placeholder="BPM min" defaultValue={sp.get('bpmMin') ?? ''} aria-label="BPM minimum" />
        <input name="bpmMax" className="input" inputMode="numeric" placeholder="BPM max" defaultValue={sp.get('bpmMax') ?? ''} aria-label="BPM maximum" />
        <input name="key" className="input" placeholder="Tonalité (Am)" defaultValue={sp.get('key') ?? ''} aria-label="Tonalité" />
        <input name="tag" className="input" placeholder="#tag" defaultValue={sp.get('tag') ?? ''} aria-label="Tag" />
        <button className="btn-ghost col-span-2 sm:col-span-1">Filtrer</button>
      </form>

      {data.searching ? (
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold">Résultats <span className="text-mute">({data.tracks.length + data.projects.length})</span></h1>
          <Link href="/app" className="text-sm text-mute underline">Effacer la recherche</Link>
        </div>
      ) : (
        <nav aria-label="Fil d’Ariane" className="flex flex-wrap items-center gap-1 text-sm">
          <Link href="/app" className={data.crumbs.length ? 'text-mute hover:text-text' : 'font-bold'}>Bibliothèque</Link>
          {data.crumbs.map((c, i) => (
            <span key={c.id} className="flex items-center gap-1">
              <span className="text-mute">/</span>
              <Link href={here({ folder: c.id })} className={i === data.crumbs.length - 1 ? 'font-bold' : 'text-mute hover:text-text'}>{c.name}</Link>
            </span>
          ))}
        </nav>
      )}

      {!data.searching && (
        <>
          <UploadZone folderId={data.folderId} />
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost" onClick={() => setMode('folder')}>+ Dossier</button>
            <button className="btn-ghost" onClick={() => setMode('project')}>+ Projet</button>
          </div>
        </>
      )}
      {mode === 'folder' && (
        <InlinePrompt testId="new-folder" label="Nom du dossier" submitLabel="Créer" onCancel={() => setMode(null)}
          onSubmit={async (name) => { await api('/api/folders', { body: { name, parentId: data.folderId } }); setMode(null); router.refresh(); }} />
      )}
      {mode === 'project' && (
        <InlinePrompt testId="new-project" label="Nom du projet" submitLabel="Créer" onCancel={() => setMode(null)}
          onSubmit={async (title) => {
            const p = await api<{ id: string }>('/api/projects', { body: { title, folderId: data.folderId } });
            router.push(`/app/projects/${p.id}`);
          }} />
      )}
      {mode && typeof mode === 'object' && (
        <InlinePrompt label="Renommer le dossier" initial={mode.name} submitLabel="Renommer" onCancel={() => setMode(null)}
          onSubmit={async (name) => { await api(`/api/folders/${mode.rename}`, { method: 'PATCH', body: { name } }); setMode(null); router.refresh(); }} />
      )}
      {moving && (
        <MoveDialog title={moving.title} excludeId={moving.kind === 'folder' ? moving.id : undefined} onClose={() => setMoving(null)}
          onPick={(folderId) => act(async () => {
            if (moving.kind === 'track') await api(`/api/tracks/${moving.id}`, { method: 'PATCH', body: { folderId } });
            else await api(`/api/folders/${moving.id}`, { method: 'PATCH', body: { parentId: folderId } });
            setMoving(null);
          })} />
      )}
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}

      {data.folders.length > 0 && (
        <section>
          <h2 className="label">Dossiers</h2>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {data.folders.map((f) => (
              <li key={f.id} data-testid="folder" data-name={f.name} className="card flex items-center gap-2 px-3 py-2.5">
                <Link href={here({ folder: f.id })} className="min-w-0 flex-1">
                  <p className="truncate font-medium">📁 {f.name}</p>
                  <p className="text-xs text-mute">{f.itemCount} élément{f.itemCount > 1 ? 's' : ''}</p>
                </Link>
                <details className="relative">
                  <summary className="cursor-pointer list-none rounded-lg px-2 py-1 text-mute hover:bg-panel-2" aria-label={`Actions ${f.name}`}>⋯</summary>
                  <div className="absolute right-0 z-10 mt-1 w-44 rounded-xl border border-line bg-panel-2 p-1 text-sm shadow-xl">
                    <button className="block w-full rounded-lg px-3 py-2 text-left hover:bg-panel" onClick={() => setMode({ rename: f.id, name: f.name })}>Renommer</button>
                    <button className="block w-full rounded-lg px-3 py-2 text-left hover:bg-panel" onClick={() => setMoving({ kind: 'folder', id: f.id, title: f.name })}>Déplacer</button>
                    <button className="block w-full rounded-lg px-3 py-2 text-left text-bad hover:bg-panel" data-testid="delete-folder"
                      onClick={() => act(() => api(`/api/folders/${f.id}`, { method: 'DELETE' }))}>
                      Supprimer (le contenu remonte)
                    </button>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.projects.length > 0 && (
        <section>
          <h2 className="label">Projets</h2>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {data.projects.map((p) => (
              <li key={p.id} data-testid="project" className="card">
                <Link href={`/app/projects/${p.id}`} className="block px-3 py-2.5">
                  <p className="truncate font-medium">{p.pinned && <span className="mr-1 text-accent">●</span>}🎛 {p.title}</p>
                  <p className="text-xs text-mute">{p.trackCount} morceau{p.trackCount > 1 ? 'x' : ''}</p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        {data.tracks.length > 0 && <h2 className="label">Morceaux</h2>}
        <TrackList tracks={data.tracks} notation={notation} actions={(t) => (
          <details className="relative">
            <summary className="cursor-pointer list-none rounded-lg px-2 py-1 text-mute hover:bg-panel-2" aria-label={`Actions ${t.title}`}>⋯</summary>
            <div className="absolute right-0 z-10 mt-1 w-44 rounded-xl border border-line bg-panel-2 p-1 text-sm shadow-xl">
              <Link href={`/app/tracks/${t.id}`} className="block rounded-lg px-3 py-2 hover:bg-panel">Détails et versions</Link>
              <button className="block w-full rounded-lg px-3 py-2 text-left hover:bg-panel" onClick={() => act(() => api(`/api/tracks/${t.id}`, { method: 'PATCH', body: { pinned: !t.pinned } }))}>
                {t.pinned ? 'Désépingler' : 'Épingler en haut'}
              </button>
              <button className="block w-full rounded-lg px-3 py-2 text-left hover:bg-panel" onClick={() => setMoving({ kind: 'track', id: t.id, title: t.title })}>Déplacer</button>
              <button className="block w-full rounded-lg px-3 py-2 text-left text-bad hover:bg-panel" onClick={() => act(() => api(`/api/tracks/${t.id}`, { method: 'DELETE' }))}>Mettre à la corbeille</button>
            </div>
          </details>
        )} />
        {!data.tracks.length && !data.folders.length && !data.projects.length && (
          <p className="py-10 text-center text-sm text-mute" data-testid="empty">
            {data.searching ? 'Aucun résultat.' : 'Rien ici pour l’instant. Dépose un beat ou un ZIP au-dessus.'}
          </p>
        )}
      </section>
    </div>
  );
}
