'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { formatDuration } from '@/lib/format';

type R = Record<string, string | number | null>;
type Detail = { campaign: R; recipients: R[] };
const STATUS: Record<string, string> = { scheduled: 'Programmé', sending: 'Envoi en cours', sent: 'Envoyé', cancelled: 'Annulé' };
const SEND: Record<string, string> = { queued: 'En attente', sending: 'En cours', sent: 'Envoyé', failed: 'Erreur', skipped: 'Non envoyé' };
const SKIP: Record<string, string> = { unsubscribed: 'désinscrit', cancelled: 'annulé' };
const when = (v: unknown) => (v ? new Date(String(v)).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

export function CampaignView({ id }: { id: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => setD(await api<Detail>(`/api/campaigns/${id}`)), [id]);
  useEffect(() => {
    load().catch((e) => setError(e.message));
    const t = setInterval(() => load().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [load]);
  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } };
  if (!d) return <p className="text-sm text-mute">{error ?? 'Chargement…'}</p>;
  const c = d.campaign;
  const target = c.projectId ? `/app/projects/${c.projectId}` : `/app/tracks/${c.trackId}`;
  return (
    <div className="space-y-5">
      <Link href="/app/campaigns" className="text-sm text-mute hover:text-text">← Envois</Link>
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">{String(c.subject)}</h1>
        <p className="text-sm text-mute"><Link href={target} className="underline">{String(c.title ?? '')}</Link> · <span data-testid="campaign-status">{STATUS[String(c.status)]}</span>
          {c.status === 'scheduled' && ` le ${when(c.scheduledAt)}`}{c.sentAt ? ` le ${when(c.sentAt)}` : ''}</p>
      </header>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {[['Envoyés', `${c.sent}/${c.recipients}`, 'sent'], ['Ouverts', c.opened, 'opened'], ['Cliqués', c.clicked, 'clicked'], ['Ont écouté', c.listened, 'listened'], ['Relances', c.followupSent, 'followup']].map(([l, v, k]) => (
          <div key={String(k)} className="card p-3"><dt className="text-xs text-mute">{l}</dt><dd className="text-xl font-semibold" data-testid={`campaign-${k}`}>{String(v)}</dd></div>
        ))}
      </dl>
      <p className="text-xs text-mute">Les ouvertures sont indicatives (certaines messageries les simulent) ; les écoutes et les clics sont fiables.</p>
      <div className="flex flex-wrap gap-2">
        {(c.status === 'scheduled' || c.status === 'sending') && <button className="btn-ghost" onClick={() => act(() => api(`/api/campaigns/${id}`, { method: 'PATCH', body: { action: 'cancel' } }))}>Annuler l’envoi</button>}
        {c.followupStatus === 'scheduled' && (
          <button className="btn-ghost" onClick={() => act(() => api(`/api/campaigns/${id}`, { method: 'PATCH', body: { action: 'cancel_followup' } }))}>Annuler la relance (J+{String(c.followupDays)})</button>
        )}
        {c.followupStatus === 'cancelled' && <span className="self-center text-sm text-mute">Relance annulée</span>}
      </div>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel text-sm" data-testid="recipients">
        {d.recipients.map((r) => (
          <li key={String(r.id)} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-testid="recipient">
            <span className="min-w-0 flex-1 truncate">{String(r.name ?? r.email)}</span>
            <span className="text-xs text-mute">
              {SEND[String(r.status)]}{r.skipReason ? ` (${SKIP[String(r.skipReason)] ?? r.skipReason})` : ''}
              {r.openedAt ? ' · ouvert' : ''}{r.clickedAt ? ' · cliqué' : ''}
              {r.listenedMs ? <span className="text-ok" data-testid="recipient-listened"> · a écouté {formatDuration(Number(r.listenedMs))}</span> : ''}
              {r.followup ? ` · relance : ${SEND[String(r.followup)]}` : ''}
            </span>
            <label className="flex items-center gap-1 text-xs text-mute">
              <input type="checkbox" checked={Boolean(r.repliedAt)} onChange={(e) => act(() => api(`/api/campaigns/sends/${r.id}`, { method: 'PATCH', body: { replied: e.target.checked } }))} />
              a répondu
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
