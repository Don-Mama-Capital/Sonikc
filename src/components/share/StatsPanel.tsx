'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { formatDuration } from '@/lib/format';
import type { linkFunnel, trackStats } from '@/lib/server/listening';

type Data = { track: Awaited<ReturnType<typeof trackStats>> | null; funnel: Awaited<ReturnType<typeof linkFunnel>> };

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)} %` : '–');
const when = (iso: string) => new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Stats d'écoute d'un morceau (et entonnoir par lien) ou d'un projet (entonnoir par lien). Rafraîchies toutes les 10 s. */
export function StatsPanel({ kind, id }: { kind: 'project' | 'track'; id: string }) {
  const [d, setD] = useState<Data | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api<Data>(`/api/stats/${kind}/${id}`).then((x) => alive && setD(x)).catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, [kind, id]);
  if (!d) return null;
  const t = d.track;
  if (!t && !d.funnel.length) return null;
  return (
    <section className="space-y-4" data-testid="stats" aria-label="Écoutes">
      <h2 className="text-lg font-semibold">Écoutes</h2>
      {t && (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="stats-totals">
          {[
            ['Écoutes', String(t.plays), 'plays'],
            ['Auditeurs uniques', String(t.listeners), 'listeners'],
            ['Temps total', formatDuration(t.totalMs), 'total'],
            ['Temps moyen', formatDuration(t.avgMs), 'avg'],
            ['Écoutes complètes', `${t.complete} (${pct(t.complete, t.plays)})`, 'complete'],
            ['Téléchargements', String(t.downloads), 'downloads'],
            ['Favoris', String(t.favorites), 'favorites'],
          ].map(([label, value, key]) => (
            <div key={key} className="card p-3">
              <dt className="text-xs text-mute">{label}</dt>
              <dd className="text-xl font-semibold" data-testid={`stat-${key}`}>{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {d.funnel.length > 0 && (
        <div className="card overflow-x-auto p-3">
          <h3 className="mb-2 text-sm font-semibold">Par lien</h3>
          <table className="w-full min-w-[520px] text-sm" data-testid="funnel">
            <thead className="text-left text-xs text-mute">
              <tr><th className="py-1 font-medium">Lien</th><th className="font-medium">Ouvertures</th><th className="font-medium">Lectures</th><th className="font-medium">&gt; 30 s</th><th className="font-medium">Complètes</th><th className="font-medium">Téléch.</th></tr>
            </thead>
            <tbody>
              {d.funnel.map((f) => (
                <tr key={f.linkId} className="border-t border-line" data-testid="funnel-row" data-label={f.label}>
                  <td className="py-1.5">{f.label}{f.revoked && <span className="ml-1 text-xs text-mute">(révoqué)</span>}</td>
                  <td>{f.opened}</td><td>{f.played}</td><td>{f.over30}</td><td>{f.complete}</td><td>{f.downloaded}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-mute">Visiteurs distincts à chaque étape. Une écoute est complète à partir de 80 % du morceau.</p>
        </div>
      )}

      {t && t.bySource.length > 0 && (
        <div className="card p-3">
          <h3 className="mb-2 text-sm font-semibold">Par source</h3>
          <ul className="space-y-1 text-sm" data-testid="by-source">
            {t.bySource.map((s) => (
              <li key={s.source} className="flex justify-between gap-2"><span className="truncate">{s.source}</span><span className="shrink-0 text-mute">{s.plays} écoute{s.plays > 1 ? 's' : ''} · {formatDuration(s.totalMs)}</span></li>
            ))}
          </ul>
        </div>
      )}

      {t && (
        <div className="card p-3">
          <h3 className="mb-2 text-sm font-semibold">Écoutes récentes</h3>
          {t.recent.length ? (
            <ul className="space-y-1 text-sm" data-testid="recent-listens">
              {t.recent.map((r) => (
                <li key={r.id} className="flex flex-wrap justify-between gap-x-3" data-testid="recent-listen">
                  <span className="truncate">{r.who ?? 'Anonyme'} <span className="text-mute">· {r.source}</span></span>
                  <span className="shrink-0 text-mute">{when(r.startedAt)} · {formatDuration(r.listenedMs)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-mute">Pas encore d’écoute. Partage un lien pour commencer.</p>}
        </div>
      )}
    </section>
  );
}
