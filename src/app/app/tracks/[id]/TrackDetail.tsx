'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client/api';
import { formatKey, type Notation } from '@/lib/audio/keys';
import { formatBytes, formatDuration } from '@/lib/format';
import type { getTrack } from '@/lib/server/library';
import { usePlayer } from '@/components/player/PlayerProvider';
import { Waveform } from '@/components/player/Waveform';
import { UploadZone } from '@/components/library/UploadZone';
import { toQueue } from '@/components/library/TrackList';
import { useRefreshWhileProcessing } from '@/components/library/LibraryView';
import { InlinePrompt } from '@/components/library/Prompt';

type Data = Awaited<ReturnType<typeof getTrack>>;

export function TrackDetail({ data, notation }: { data: Data; notation: Notation }) {
  const { track, versions, projects } = data;
  const router = useRouter();
  const player = usePlayer();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  useRefreshWhileProcessing([track, ...versions.map((v) => ({ ...track, version: { ...track.version!, status: v.status } }))]);

  const isCurrent = player.current?.id === track.id;
  const progress = isCurrent && player.duration ? player.time / player.duration : 0;
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); router.refresh(); } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="space-y-6">
      <Link href={track.folderId ? `/app?folder=${track.folderId}` : '/app'} className="text-sm text-mute hover:text-text">← Bibliothèque</Link>
      <div className="flex items-center gap-3">
        <button aria-label="Écouter" data-testid="play-detail" disabled={!track.version?.previewUrl}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent text-xl text-ink disabled:opacity-30"
          onClick={() => (isCurrent ? player.toggle() : player.playList(toQueue([track])))}>
          {isCurrent && player.playing ? '❚❚' : '▶'}
        </button>
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold" data-testid="track-title">{track.title}</h1>
          <p className="text-sm text-mute">Version écoutée : {track.version?.label ?? '–'} · {formatDuration(track.version?.durationMs)}</p>
        </div>
      </div>
      <Waveform peaks={track.version?.waveform ?? null} progress={progress} height={64}
        onSeek={isCurrent ? player.seek : undefined} />

      <form className="card grid gap-3 p-4 sm:grid-cols-2" data-testid="track-form" onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const bpmRaw = String(f.get('bpm') ?? '').replace(',', '.').trim();
        act(async () => {
          await api(`/api/tracks/${track.id}`, { method: 'PATCH', body: {
            title: String(f.get('title') ?? ''),
            bpm: bpmRaw ? Number(bpmRaw) : null,
            key: String(f.get('key') ?? ''),
            tags: String(f.get('tags') ?? '').split(/[,\s]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean),
          } });
          setSaved(true); setTimeout(() => setSaved(false), 2000);
        });
      }}>
        <label className="sm:col-span-2"><span className="label">Titre</span>
          <input name="title" className="input" defaultValue={track.title} required maxLength={160} /></label>
        <label><span className="label">BPM {track.bpmSource === 'detected' && <em className="normal-case text-mute">(détecté)</em>}</span>
          <input name="bpm" className="input" inputMode="decimal" defaultValue={track.bpm ?? ''} placeholder="ex. 140" /></label>
        <label><span className="label">Tonalité {track.keySource === 'detected' && <em className="normal-case text-mute">(détectée)</em>}</span>
          <input name="key" className="input" defaultValue={formatKey(track.keyPc, track.keyMode, notation) ?? ''} placeholder="ex. A min, F# maj" /></label>
        <label className="sm:col-span-2"><span className="label">Tags</span>
          <input name="tags" className="input" defaultValue={track.tags.map((t) => `#${t}`).join(' ')} placeholder="#trap #dark" /></label>
        <div className="flex items-center gap-3 sm:col-span-2">
          <button className="btn-primary">Enregistrer</button>
          {saved && <span className="text-sm text-ok" data-testid="saved">Enregistré</span>}
          {error && <span role="alert" className="text-sm text-bad">{error}</span>}
        </div>
      </form>

      <section className="space-y-2">
        <h2 className="label">Versions</h2>
        <UploadZone trackId={track.id} compact />
        {renaming && (
          <InlinePrompt label="Nom de la version (ex. master)" initial={renaming.label} submitLabel="Renommer" testId="rename-version"
            onCancel={() => setRenaming(null)}
            onSubmit={async (label) => { await api(`/api/versions/${renaming.id}`, { method: 'PATCH', body: { label } }); setRenaming(null); router.refresh(); }} />
        )}
        <ul className="divide-y divide-line rounded-2xl border border-line bg-panel" data-testid="versions">
          {versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm" data-testid="version-row">
              <span className="w-16 font-semibold">{v.label}</span>
              <span className="min-w-0 flex-1 truncate text-mute">{v.originalFilename} · {formatBytes(v.sizeBytes)} · {formatDuration(v.durationMs)}</span>
              {v.status === 'ready' && v.id !== track.version?.id && (
                <button className="btn-ghost py-1" onClick={() => act(() => api(`/api/tracks/${track.id}/current-version`, { body: { versionId: v.id } }))}>Écouter celle-ci</button>
              )}
              {v.id === track.version?.id && <span className="text-xs text-accent">écoutée</span>}
              {v.status === 'processing' && <span className="text-xs text-mute">analyse…</span>}
              {v.status === 'failed' && <span className="text-xs text-bad">{v.error}</span>}
              <button className="text-xs text-mute underline" onClick={() => setRenaming({ id: v.id, label: v.label })}>renommer</button>
              {v.sha256 && <span className="w-full break-all font-mono text-[10px] text-mute" title="Empreinte SHA-256 du fichier envoyé">SHA-256 {v.sha256}</span>}
            </li>
          ))}
        </ul>
      </section>

      {projects.length > 0 && (
        <section>
          <h2 className="label">Dans les projets</h2>
          <ul className="flex flex-wrap gap-2">{projects.map((p) => <li key={p.id}><Link className="btn-ghost py-1" href={`/app/projects/${p.id}`}>{p.title}</Link></li>)}</ul>
        </section>
      )}

      <button className="text-sm text-bad underline" onClick={() => act(async () => {
        await api(`/api/tracks/${track.id}`, { method: 'DELETE' });
        router.push(track.folderId ? `/app?folder=${track.folderId}` : '/app');
      })}>Mettre à la corbeille</button>
    </div>
  );
}
