'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client/api';
import type { listContacts, listGroups } from '@/lib/server/contacts';

type List = Awaited<ReturnType<typeof listContacts>>;
type Groups = Awaited<ReturnType<typeof listGroups>>;
type ImportResult = { lines: number; created: number; merged: number; invalidCount: number; invalid: { line: number; reason: string }[] };

const RULES = [
  { value: 'manual', label: 'Groupe manuel (tu choisis les membres)' },
  { value: 'listened_over', label: 'A écouté plus de … secondes' },
  { value: 'tag', label: 'A le tag …' },
  { value: 'score_min', label: 'Score d’activité au moins …' },
  { value: 'inactive', label: 'Sans activité depuis … jours' },
];

const ago = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—');

export function ContactsView() {
  const [list, setList] = useState<List | null>(null);
  const [groups, setGroups] = useState<Groups>([]);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [group, setGroup] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'none' | 'add' | 'import' | 'group'>('none');
  const [imp, setImp] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (q.trim()) p.set('q', q.trim());
    if (tag) p.set('tag', tag);
    if (group) p.set('group', group);
    const [l, g] = await Promise.all([api<List>(`/api/contacts?${p}`), api<Groups>('/api/contact-groups')]);
    setList(l); setGroups(g);
  }, [q, tag, group]);
  useEffect(() => { const t = setTimeout(() => { load().catch((e) => setError(e.message)); }, 200); return () => clearTimeout(t); }, [load]);
  const act = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Contacts <span className="text-base font-normal text-mute" data-testid="contacts-total">{list ? list.total : ''}</span></h1>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => setPanel(panel === 'add' ? 'none' : 'add')}>Ajouter</button>
          <button className="btn-ghost" onClick={() => setPanel(panel === 'import' ? 'none' : 'import')}>Importer</button>
          <button className="btn-ghost" onClick={() => setPanel(panel === 'group' ? 'none' : 'group')}>Nouveau groupe</button>
        </div>
      </div>

      {panel === 'add' && <AddForm onDone={() => act(async () => setPanel('none'))} onError={setError} />}
      {panel === 'import' && (
        <section className="card space-y-2 p-4" aria-label="Importer">
          <p className="text-sm text-mute">Fichier CSV exporté d’un tableur ou de ta messagerie : une colonne email (obligatoire), nom et tags si tu les as. Séparateur virgule ou point-virgule. Les doublons sont fusionnés.</p>
          <label className="label" htmlFor="csv-file">Fichier CSV</label>
          <input id="csv-file" ref={fileRef} type="file" accept=".csv,text/csv,text/plain" data-testid="csv-input" className="block text-sm"
            onChange={async (e) => {
              const f = e.target.files?.[0]; if (!f) return;
              setImp(null);
              await act(async () => setImp(await api<ImportResult>('/api/contacts/import', { body: { csv: await f.text() } })));
              if (fileRef.current) fileRef.current.value = '';
            }} />
          {imp && (
            <p className="text-sm" role="status" data-testid="import-result">
              {imp.created} contact{imp.created > 1 ? 's' : ''} ajouté{imp.created > 1 ? 's' : ''}, {imp.merged} fusionné{imp.merged > 1 ? 's' : ''}
              {imp.invalidCount > 0 && <>, {imp.invalidCount} ligne{imp.invalidCount > 1 ? 's' : ''} ignorée{imp.invalidCount > 1 ? 's' : ''} ({imp.invalid.slice(0, 3).map((x) => `ligne ${x.line} : ${x.reason}`).join(' ; ')}{imp.invalidCount > 3 ? '…' : ''})</>}.
            </p>
          )}
        </section>
      )}
      {panel === 'group' && <GroupForm onDone={() => act(async () => setPanel('none'))} onError={setError} />}
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}

      <div className="flex gap-2 overflow-x-auto pb-1 text-sm" aria-label="Groupes" data-testid="groups">
        <button className={`shrink-0 rounded-full border px-3 py-1 ${!group ? 'border-accent text-text' : 'border-line text-mute'}`} onClick={() => setGroup(null)}>Tous</button>
        {groups.map((g) => (
          <button key={g.id} title={g.description} data-testid="group-chip"
            className={`shrink-0 rounded-full border px-3 py-1 ${group === g.id ? 'border-accent text-text' : 'border-line text-mute'}`}
            onClick={() => setGroup(g.id)}>
            {g.name} <span className="text-mute">{g.size}</span>
          </button>
        ))}
      </div>
      {group && (
        <p className="flex justify-between gap-2 text-xs text-mute">
          <span>{groups.find((g) => g.id === group)?.description}</span>
          <button className="underline hover:text-text" onClick={() => act(async () => { await api(`/api/contact-groups/${group}`, { method: 'DELETE' }); setGroup(null); })}>Supprimer le groupe</button>
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="contact-search">Rechercher</label>
        <input id="contact-search" className="input max-w-sm" placeholder="Rechercher un nom ou une adresse" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {list && list.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 text-xs" aria-label="Tags">
          {list.tags.map((t) => (
            <button key={t.tag} className={`rounded-full border px-2 py-0.5 ${tag === t.tag ? 'border-accent text-text' : 'border-line text-mute'}`} onClick={() => setTag(tag === t.tag ? null : t.tag)}>
              {t.tag} {t.n}
            </button>
          ))}
        </div>
      )}

      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel" data-testid="contacts">
        {list?.contacts.map((c) => (
          <li key={c.id} data-testid="contact-row">
            <Link href={`/app/contacts/${c.id}`} className="flex items-center gap-3 px-3 py-2.5 hover:bg-panel-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{c.name ?? c.email}{c.unsubscribed && <span className="ml-2 text-xs text-mute">désinscrit</span>}</p>
                <p className="truncate text-xs text-mute">{c.name ? c.email : ''}{c.tags.length ? `${c.name ? ' · ' : ''}${c.tags.join(', ')}` : ''}</p>
              </div>
              <span className="shrink-0 text-right text-xs text-mute">
                <span className="block text-sm font-semibold text-text" title="Score d’activité (90 jours)">{c.score}</span>
                {ago(c.lastActivityAt)}
              </span>
            </Link>
          </li>
        ))}
        {list && !list.contacts.length && <li className="px-3 py-4 text-sm text-mute">Aucun contact ici. Importe un fichier CSV ou ajoute un contact.</li>}
      </ul>
      <p className="text-xs text-mute">Score d’activité sur 90 jours : écoute de plus de 30 s = 1, écoute complète = 3, téléchargement ou enregistrement = 5, clic dans un email = 1.</p>
    </div>
  );
}

function AddForm({ onDone, onError }: { onDone: () => void; onError: (m: string) => void }) {
  const [email, setEmail] = useState(''); const [name, setName] = useState(''); const [tags, setTags] = useState('');
  return (
    <form className="card grid gap-2 p-4 sm:grid-cols-4" onSubmit={async (e) => {
      e.preventDefault();
      try { await api('/api/contacts', { body: { email, name: name || null, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) } }); onDone(); }
      catch (err) { onError((err as Error).message); }
    }}>
      <label className="sr-only" htmlFor="c-email">Email</label>
      <input id="c-email" type="email" required className="input" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <label className="sr-only" htmlFor="c-name">Nom</label>
      <input id="c-name" className="input" placeholder="Nom (facultatif)" value={name} onChange={(e) => setName(e.target.value)} />
      <label className="sr-only" htmlFor="c-tags">Tags</label>
      <input id="c-tags" className="input" placeholder="Tags, séparés par des virgules" value={tags} onChange={(e) => setTags(e.target.value)} />
      <button className="btn-primary">Ajouter</button>
    </form>
  );
}

function GroupForm({ onDone, onError }: { onDone: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState(''); const [type, setType] = useState('manual'); const [value, setValue] = useState('');
  return (
    <form className="card grid gap-2 p-4 sm:grid-cols-4" onSubmit={async (e) => {
      e.preventDefault();
      const n = Number(value);
      const rule = type === 'manual' ? null : type === 'tag' ? { type, tag: value } : type === 'listened_over' ? { type, seconds: n } : type === 'score_min' ? { type, min: n } : { type, days: n };
      try { await api('/api/contact-groups', { body: { name, rule } }); onDone(); } catch (err) { onError((err as Error).message); }
    }}>
      <label className="sr-only" htmlFor="g-name">Nom du groupe</label>
      <input id="g-name" required maxLength={60} className="input" placeholder="Nom du groupe" value={name} onChange={(e) => setName(e.target.value)} />
      <label className="sr-only" htmlFor="g-type">Règle</label>
      <select id="g-type" className="input sm:col-span-2" value={type} onChange={(e) => setType(e.target.value)}>
        {RULES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
      </select>
      {type !== 'manual' && (
        <>
          <label className="sr-only" htmlFor="g-value">Valeur</label>
          <input id="g-value" required className="input" inputMode={type === 'tag' ? 'text' : 'numeric'} placeholder={type === 'tag' ? 'tag' : 'nombre'} value={value} onChange={(e) => setValue(e.target.value)} />
        </>
      )}
      <button className="btn-primary sm:col-start-4">Créer</button>
    </form>
  );
}
