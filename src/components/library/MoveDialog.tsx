'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';

type Folder = { id: string; name: string; parentId: string | null };

/** Choix d'un dossier de destination (arborescence complète, racine comprise). */
export function MoveDialog({ title, excludeId, onPick, onClose }: { title: string; excludeId?: string; onPick: (folderId: string | null) => void; onClose: () => void }) {
  const [folders, setFolders] = useState<Folder[] | null>(null);
  useEffect(() => { api<Folder[]>('/api/folders').then(setFolders).catch(() => setFolders([])); }, []);
  // On masque le dossier déplacé et tous ses descendants.
  const hidden = new Set<string>();
  if (excludeId && folders) {
    hidden.add(excludeId);
    let grew = true;
    while (grew) { grew = false; for (const f of folders) if (f.parentId && hidden.has(f.parentId) && !hidden.has(f.id)) { hidden.add(f.id); grew = true; } }
  }
  const tree = (parent: string | null, depth: number): React.ReactNode[] =>
    (folders ?? []).filter((f) => f.parentId === parent && !hidden.has(f.id)).flatMap((f) => [
      <button key={f.id} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-panel-2" style={{ paddingLeft: 12 + depth * 16 }} onClick={() => onPick(f.id)}>📁 {f.name}</button>,
      ...tree(f.id, depth + 1),
    ]);
  return (
    <div className="card p-3" data-testid="move-dialog">
      <p className="mb-2 text-sm">Déplacer <span className="font-semibold">{title}</span> vers :</p>
      <div className="max-h-64 overflow-auto">
        <button className="block w-full rounded-lg px-3 py-2 text-left hover:bg-panel-2" onClick={() => onPick(null)}>Bibliothèque (racine)</button>
        {folders === null ? <p className="px-3 py-2 text-sm text-mute">Chargement…</p> : tree(null, 1)}
      </div>
      <button className="btn-ghost mt-2" onClick={onClose}>Annuler</button>
    </div>
  );
}
