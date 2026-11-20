'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { euros } from '@/lib/licences';

type Row = { id: string; name: string; priceCents: number; formats: string[]; enabled: boolean; overrideCents: number | null };

/** Licences proposées pour un morceau en vente : activer ou non chaque licence, prix propre au morceau (HT). */
export function TrackLicences({ trackId, inherited }: { trackId: string; inherited: boolean }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => setRows(await api<Row[]>(`/api/tracks/${trackId}/licences`)), [trackId]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  const save = async (r: Row, patch: Partial<Pick<Row, 'enabled' | 'overrideCents'>>) => {
    const next = { ...r, ...patch };
    setRows((rs) => rs!.map((x) => (x.id === r.id ? next : x)));
    setError(null);
    try { await api(`/api/tracks/${trackId}/licences/${r.id}`, { method: 'PUT', body: { enabled: next.enabled, priceCents: next.overrideCents } }); }
    catch (e) { setError((e as Error).message); await load(); }
  };
  if (!rows) return null;
  return (
    <div className="space-y-2" data-testid="track-licences">
      <p className="label">Licences de ce morceau</p>
      {inherited && <p className="text-xs text-mute">Utilisées si le projet de ce morceau est « En vente ».</p>}
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-3 py-2">
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <input type="checkbox" checked={r.enabled} onChange={(e) => save(r, { enabled: e.target.checked })} />
              <span className="truncate">{r.name}</span>
              {r.formats.includes('stems') && <span className="text-xs text-mute">(bientôt : livraison des stems)</span>}
            </label>
            <label className="flex items-center gap-1 text-sm">
              <span className="text-mute">Prix HT</span>
              <input className="input max-w-24" type="number" min={1} step="0.01" inputMode="decimal" aria-label={`Prix HT de ${r.name} pour ce morceau`}
                placeholder={(r.priceCents / 100).toFixed(2)} defaultValue={r.overrideCents === null ? '' : (r.overrideCents / 100).toFixed(2)}
                onBlur={(e) => {
                  const v = e.target.value.trim().replace(',', '.');
                  const cents = v === '' ? null : Math.round(Number(v) * 100);
                  if (cents !== r.overrideCents && (cents === null || Number.isFinite(cents))) save(r, { overrideCents: cents });
                }} />
              <span className="text-mute">€</span>
            </label>
          </li>
        ))}
      </ul>
      <p className="text-xs text-mute">Vide = prix de la licence ({rows[0] ? `ex. ${euros(rows[0].priceCents)} HT` : ''}). Modifie tes licences dans <a className="underline" href="/app/boutique">Ma page</a>.</p>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
    </div>
  );
}
