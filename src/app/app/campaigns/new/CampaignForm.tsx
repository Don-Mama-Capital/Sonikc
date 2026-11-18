'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import type { listGroups } from '@/lib/server/contacts';

type Groups = Awaited<ReturnType<typeof listGroups>>;

export function CampaignForm({ kind, id, title, visibility, ownerName }: { kind: 'project' | 'track'; id: string; title: string; visibility: string | null; ownerName: string }) {
  const router = useRouter();
  const [groups, setGroups] = useState<Groups>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [groupId, setGroupId] = useState('');
  const [subject, setSubject] = useState(`${title} — pour toi`);
  const [body, setBody] = useState(`Salut {prenom},\n\nJe t’envoie « ${title} ». Dis-moi ce que tu en penses.\n\n${ownerName}`);
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const [follow, setFollow] = useState(true);
  const [days, setDays] = useState(3);
  const [fSubject, setFSubject] = useState(`Tu as pu écouter « ${title} » ?`);
  const [fBody, setFBody] = useState(`Salut {prenom},\n\nPetite relance pour « ${title} ». Si ce n’est pas le moment, aucun souci.\n\n${ownerName}`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<Groups>('/api/contact-groups').then(setGroups).catch(() => {});
    api<{ total: number }>('/api/contacts').then((l) => setTotal(l.total)).catch(() => {});
  }, []);
  const privateTarget = !visibility || visibility === 'private';
  const back = kind === 'project' ? `/app/projects/${id}` : `/app/tracks/${id}`;

  return (
    <form className="mx-auto max-w-2xl space-y-5" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setError(null);
      try {
        const r = await api<{ id: string }>('/api/campaigns', { body: {
          kind, id, subject, body, groupId: groupId || null,
          scheduledAt: when === 'later' && at ? new Date(at).toISOString() : null,
          followup: follow ? { days, subject: fSubject, body: fBody } : null,
        } });
        router.push(`/app/campaigns/${r.id}`);
      } catch (err) { setError((err as Error).message); setBusy(false); }
    }}>
      <Link href={back} className="text-sm text-mute hover:text-text">← {title}</Link>
      <h1 className="text-2xl font-bold">Envoyer « {title} » par email</h1>
      {privateTarget && (
        <p role="alert" className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
          Ce partage est privé. Ouvre « Partager » et choisis « Public » ou « Sur invitation » avant de l’envoyer.
        </p>
      )}
      {visibility === 'invite' && <p className="text-sm text-mute">Partage sur invitation : chaque destinataire sera invité et devra se connecter avec son adresse.</p>}

      <div>
        <label className="label" htmlFor="audience">Destinataires</label>
        <select id="audience" className="input" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">Tous mes contacts{total !== null ? ` (${total})` : ''}</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.size})</option>)}
        </select>
        <p className="mt-1 text-xs text-mute">Les contacts désinscrits sont toujours exclus. Chacun reçoit son propre lien : tu verras qui écoute.</p>
      </div>
      <div>
        <label className="label" htmlFor="subject">Objet</label>
        <input id="subject" required maxLength={150} className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="body">Message</label>
        <textarea id="body" required maxLength={5000} rows={7} className="input" value={body} onChange={(e) => setBody(e.target.value)} />
        <p className="mt-1 text-xs text-mute">{'{prenom}'} et {'{nom}'} sont remplacés pour chaque destinataire. Le bouton « Écouter » et le lien de désinscription sont ajoutés automatiquement.</p>
      </div>

      <fieldset className="space-y-2">
        <legend className="label">Quand</legend>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name="when" checked={when === 'now'} onChange={() => setWhen('now')} /> Maintenant</label>
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <input type="radio" name="when" checked={when === 'later'} onChange={() => setWhen('later')} /> Programmer le
          <input type="datetime-local" aria-label="Date et heure d’envoi" className="input w-auto" value={at} disabled={when !== 'later'} required={when === 'later'} onChange={(e) => setAt(e.target.value)} />
        </label>
      </fieldset>

      <fieldset className="card space-y-3 p-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Relancer ceux qui n’ont ni écouté, ni cliqué, ni répondu
        </label>
        {follow && (
          <>
            <label className="flex items-center gap-2 text-sm">
              après <input type="number" min={1} max={60} className="input w-20" aria-label="Nombre de jours avant la relance" value={days} onChange={(e) => setDays(Number(e.target.value))} /> jours
            </label>
            <div><label className="label" htmlFor="f-subject">Objet de la relance</label><input id="f-subject" required maxLength={150} className="input" value={fSubject} onChange={(e) => setFSubject(e.target.value)} /></div>
            <div><label className="label" htmlFor="f-body">Message de la relance</label><textarea id="f-body" required rows={5} maxLength={5000} className="input" value={fBody} onChange={(e) => setFBody(e.target.value)} /></div>
          </>
        )}
      </fieldset>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      <button className="btn-primary w-full sm:w-auto" disabled={busy || privateTarget}>{busy ? 'Préparation…' : when === 'later' ? 'Programmer l’envoi' : 'Envoyer'}</button>
    </form>
  );
}
