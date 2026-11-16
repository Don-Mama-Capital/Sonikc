'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client/api';

type Item = { name: string; progress: number; state: 'envoi' | 'traitement' | 'erreur'; error?: string };
type Ticket = { kind: string; id: string; uploadUrl: string; completeUrl: string };

function putWithProgress(url: string, file: File, onProgress: (f: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(JSON.parse(xhr.responseText || '{}').error ?? 'Échec de l’envoi.')));
    xhr.onerror = () => reject(new Error('Connexion perdue pendant l’envoi.'));
    xhr.send(file);
  });
}

/**
 * Envoi de fichiers : glisser-déposer ou sélection. Accepte WAV, MP3, AIFF, FLAC et ZIP.
 * `trackId` : envoie une nouvelle version de ce morceau au lieu d'un nouveau morceau.
 */
export function UploadZone({ folderId, projectId, trackId, compact = false }: { folderId?: string | null; projectId?: string; trackId?: string; compact?: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [over, setOver] = useState(false);

  async function send(files: File[]) {
    const start = items.length;
    setItems((prev) => [...prev, ...files.map((f) => ({ name: f.name, progress: 0, state: 'envoi' as const }))]);
    const set = (i: number, patch: Partial<Item>) => setItems((prev) => prev.map((it, j) => (j === start + i ? { ...it, ...patch } : it)));
    await Promise.all(files.map(async (file, i) => {
      try {
        const t = await api<Ticket>('/api/uploads', { body: { filename: file.name, size: file.size, folderId: folderId ?? null, projectId, trackId } });
        await putWithProgress(t.uploadUrl, file, (p) => set(i, { progress: p }));
        await api(t.completeUrl, { method: 'POST' });
        set(i, { progress: 1, state: 'traitement' });
      } catch (e) {
        set(i, { state: 'erreur', error: (e as Error).message });
      }
    }));
    router.refresh();
    setTimeout(() => setItems((prev) => prev.filter((it) => it.state === 'erreur')), 4000);
  }

  return (
    <div>
      <div
        data-testid="dropzone"
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); send(Array.from(e.dataTransfer.files)); }}
        className={`flex items-center justify-between gap-3 rounded-2xl border border-dashed px-4 ${compact ? 'py-2' : 'py-5'} transition ${over ? 'border-accent bg-accent/10' : 'border-line'}`}
      >
        <p className="text-sm text-mute">
          {trackId ? 'Dépose la nouvelle version ici' : 'Dépose tes beats ici'} <span className="hidden sm:inline">· WAV, MP3, AIFF, FLAC{trackId ? '' : ' ou ZIP'}</span>
        </p>
        <button type="button" className="btn-primary shrink-0" onClick={() => input.current?.click()}>
          {trackId ? 'Nouvelle version' : 'Importer'}
        </button>
        <input ref={input} data-testid="file-input" type="file" multiple={!trackId} hidden
          accept={trackId ? '.wav,.mp3,.aif,.aiff,.flac' : '.wav,.mp3,.aif,.aiff,.flac,.zip'}
          onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; if (f.length) send(f); }} />
      </div>
      {items.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="upload-list">
          {items.map((it, i) => (
            <li key={i} className="flex items-center gap-3 text-sm">
              <span className="min-w-0 flex-1 truncate">{it.name}</span>
              {it.state === 'erreur'
                ? <span role="alert" className="text-bad">{it.error}</span>
                : <span className="font-mono text-xs text-mute">{it.state === 'envoi' ? `${Math.round(it.progress * 100)} %` : 'analyse…'}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
