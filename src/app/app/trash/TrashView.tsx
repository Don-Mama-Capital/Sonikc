'use client';

import { useRouter } from 'next/navigation';
import { api } from '@/lib/client/api';
import type { TrackRow } from '@/lib/server/library';

export function TrashView({ tracks }: { tracks: TrackRow[] }) {
  const router = useRouter();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Corbeille</h1>
      <p className="text-sm text-mute">Les morceaux mis à la corbeille restent récupérables. Rien n’est supprimé définitivement pour l’instant.</p>
      {!tracks.length && <p className="py-8 text-center text-sm text-mute">La corbeille est vide.</p>}
      <ul className="divide-y divide-line rounded-2xl border border-line bg-panel">
        {tracks.map((t) => (
          <li key={t.id} className="flex items-center gap-3 px-3 py-2.5" data-testid="trash-row">
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
            <button className="btn-ghost py-1" onClick={async () => { await api(`/api/tracks/${t.id}/restore`, { method: 'POST' }); router.refresh(); }}>Restaurer</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
