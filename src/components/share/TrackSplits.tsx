'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';

type Split = { handle: string; displayName?: string; role: string; pct: number; payoutsReady?: boolean };

/** Collaborateurs d'un morceau en vente : leur part des revenus (le reste revient au propriétaire). */
export function TrackSplits({ trackId }: { trackId: string }) {
  const [rows, setRows] = useState<Split[] | null>(null);
  const [draft, setDraft] = useState({ handle: '', role: '', pct: '' });
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => setRows(await api<Split[]>(`/api/tracks/${trackId}/splits`)), [trackId]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  const save = async (next: Split[]) => {
    setError(null);
    try { setRows(await api<Split[]>(`/api/tracks/${trackId}/splits`, { method: 'PUT', body: { splits: next.map(({ handle, role, pct }) => ({ handle, role, pct })) } })); return true; }
    catch (e) { setError((e as Error).message); return false; }
  };
  if (!rows) return null;
  const mine = Math.round((100 - rows.reduce((a, r) => a + r.pct, 0)) * 100) / 100;
  return (
    <div className="space-y-2" data-testid="track-splits">
      <p className="label">Collaborateurs</p>
      <ul className="space-y-1 text-sm">
        <li className="flex justify-between"><span>Toi</span><span>{String(mine).replace('.', ',')} %</span></li>
        {rows.map((r) => (
          <li key={r.handle} className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">@{r.handle}{r.role && <span className="text-mute"> · {r.role}</span>}
              {!r.payoutsReady && <span className="text-xs text-mute"> · reversements pas encore activés</span>}</span>
            <span className="flex items-center gap-2">{String(r.pct).replace('.', ',')} %
              <button className="text-xs text-mute underline hover:text-text" onClick={() => save(rows.filter((x) => x.handle !== r.handle))}>Retirer</button></span>
          </li>
        ))}
      </ul>
      <form className="flex flex-wrap gap-2" onSubmit={async (e) => {
        e.preventDefault();
        if (await save([...rows, { handle: draft.handle.replace(/^@/, ''), role: draft.role, pct: Number(draft.pct.replace(',', '.')) }])) setDraft({ handle: '', role: '', pct: '' });
      }}>
        <input className="input max-w-36" placeholder="@identifiant" aria-label="Identifiant Sonikc du collaborateur" value={draft.handle} required onChange={(e) => setDraft({ ...draft, handle: e.target.value })} />
        <input className="input max-w-32" placeholder="Rôle (facultatif)" aria-label="Rôle" value={draft.role} maxLength={40} onChange={(e) => setDraft({ ...draft, role: e.target.value })} />
        <input className="input max-w-20" placeholder="%" aria-label="Part en %" inputMode="decimal" value={draft.pct} required onChange={(e) => setDraft({ ...draft, pct: e.target.value })} />
        <button className="btn-ghost" type="submit">Ajouter</button>
      </form>
      <p className="text-xs text-mute">Parts calculées sur ce qui reste après TVA, commission et frais de paiement. Chaque collaborateur reçoit sa part sur son propre compte de reversement.</p>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
    </div>
  );
}
