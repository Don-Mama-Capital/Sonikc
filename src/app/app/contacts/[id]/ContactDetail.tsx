'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { formatDuration } from '@/lib/format';
import type { contactDetail, listGroups } from '@/lib/server/contacts';

type Detail = Awaited<ReturnType<typeof contactDetail>>;
type Groups = Awaited<ReturnType<typeof listGroups>>;
const when = (iso: string) => new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const KIND: Record<string, string> = { download: 'A téléchargé', favorite: 'A mis en favori', save: 'A enregistré' };

export function ContactDetail({ id }: { id: string }) {
  const router = useRouter();
  const [d, setD] = useState<Detail | null>(null);
  const [groups, setGroups] = useState<Groups>([]);
  const [name, setName] = useState(''); const [tags, setTags] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [x, g] = await Promise.all([api<Detail>(`/api/contacts/${id}`), api<Groups>('/api/contact-groups')]);
    setD(x); setGroups(g); setName(x.contact.name ?? ''); setTags(x.contact.tags.join(', '));
  }, [id]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } };
  if (!d) return <p className="text-sm text-mute">{error ?? 'Chargement…'}</p>;
  const c = d.contact;
  const manual = groups.filter((g) => !g.rule);
  return (
    <div className="space-y-5">
      <Link href="/app/contacts" className="text-sm text-mute hover:text-text">← Contacts</Link>
      <header className="space-y-1">
        <h1 className="break-all text-2xl font-bold" data-testid="contact-name">{c.name ?? c.email}</h1>
        <p className="break-all text-sm text-mute">{c.email}{c.unsubscribed && ' · désinscrit des emails'}</p>
        <p className="text-sm">Score <strong data-testid="contact-score">{c.score}</strong> · {c.plays} écoute{c.plays > 1 ? 's' : ''} · dernière activité {c.lastActivityAt ? when(c.lastActivityAt) : '—'}</p>
      </header>

      <form className="card grid gap-2 p-4 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); act(() => api(`/api/contacts/${id}`, { method: 'PATCH', body: { name: name || null, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) } })); }}>
        <div><label className="label" htmlFor="d-name">Nom</label><input id="d-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><label className="label" htmlFor="d-tags">Tags</label><input id="d-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} /></div>
        <div className="flex items-end"><button className="btn-primary w-full">Enregistrer</button></div>
      </form>

      {manual.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Groupes manuels</h2>
          <div className="flex flex-wrap gap-2 text-sm">
            {manual.map((g) => {
              const inIt = d.groups.some((x) => x.id === g.id);
              return (
                <button key={g.id} className={`rounded-full border px-3 py-1 ${inIt ? 'border-accent' : 'border-line text-mute'}`} aria-pressed={inIt}
                  onClick={() => act(() => api(`/api/contact-groups/${g.id}/members`, { body: { contactIds: [id], add: !inIt } }))}>
                  {inIt ? '✓ ' : '+ '}{g.name}
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Écoutes</h2>
        <ul className="divide-y divide-line rounded-2xl border border-line bg-panel text-sm" data-testid="contact-listens">
          {d.listens.map((l) => (
            <li key={l.id} className="flex flex-wrap justify-between gap-x-3 px-3 py-2">
              <span className="truncate">{l.title ?? 'Morceau supprimé'} <span className="text-mute">· {l.source}</span></span>
              <span className="shrink-0 text-mute">{when(l.startedAt)} · {formatDuration(l.listenedMs)}{l.durationMs ? ` / ${formatDuration(l.durationMs)}` : ''}</span>
            </li>
          ))}
          {!d.listens.length && <li className="px-3 py-3 text-mute">Pas encore d’écoute rattachée à ce contact. Elles le seront dès qu’il ouvrira un lien que tu lui envoies.</li>}
        </ul>
        {d.events.length > 0 && (
          <ul className="space-y-1 text-sm text-mute">
            {d.events.map((e, i) => <li key={i}>{KIND[e.kind] ?? e.kind} « {e.title ?? '—'} » · {when(e.at)}</li>)}
          </ul>
        )}
      </section>

      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      <button className="text-sm text-mute underline hover:text-text" onClick={async () => {
        if (!confirm('Supprimer ce contact ? Son historique reste dans tes stats, sans son nom.')) return;
        await api(`/api/contacts/${id}`, { method: 'DELETE' }); router.push('/app/contacts');
      }}>Supprimer le contact</button>
    </div>
  );
}
