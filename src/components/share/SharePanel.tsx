'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import type { getShareSettings } from '@/lib/server/sharing';

type Settings = Awaited<ReturnType<typeof getShareSettings>>;
type Vis = 'inherit' | 'private' | 'invite' | 'public';

const INHERIT = { value: 'inherit' as const, label: 'Suit le projet', help: 'Écoutable dans les projets partagés ; privé s’il est partagé seul.' };
const LEVELS: { value: Vis; label: string; help: string }[] = [
  { value: 'private', label: 'Privé', help: 'Toi seul. Les liens existants ne fonctionnent pas.' },
  { value: 'invite', label: 'Sur invitation', help: 'Seules les adresses invitées, après connexion.' },
  { value: 'public', label: 'Public', help: 'Toute personne qui a un lien. Mot de passe possible.' },
];

/** Réglages de partage d'un projet ou d'un morceau : niveau, liens, invitations, mot de passe, téléchargement. */
export function SharePanel({ kind, id, onClose }: { kind: 'project' | 'track'; id: string; onClose: () => void }) {
  const base = `/api/share/${kind}/${id}`;
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => setS(await api<Settings>(base)), [base]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
  };
  if (!s) return <section className="card p-4 text-sm text-mute">Chargement du partage…</section>;
  const vis = (s.visibility === 'for_sale' ? 'public' : s.visibility) as Vis;
  const levels = kind === 'track' ? [INHERIT, ...LEVELS.map((l) => (l.value === 'private' ? { ...l, help: 'Toi seul, même dans un projet partagé.' } : l))] : LEVELS;
  const activeLinks = s.links.filter((l) => !l.revokedAt);

  return (
    <section className="card space-y-5 p-4" data-testid="share-panel" aria-label="Partage">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Partage</h2>
        <button className="text-sm text-mute underline hover:text-text" onClick={onClose}>Fermer</button>
      </div>

      <fieldset className="space-y-2">
        <legend className="label">Qui peut écouter</legend>
        {levels.map((l) => (
          <label key={l.value} className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2 ${vis === l.value ? 'border-accent' : 'border-line'}`}>
            <input type="radio" name={`vis-${id}`} className="mt-1" checked={vis === l.value} data-testid={`vis-${l.value}`}
              onChange={() => { setS({ ...s, visibility: l.value }); act(() => api(base, { method: 'PATCH', body: { visibility: l.value } })); }} />
            <span><span className="font-medium">{l.label}</span><span className="block text-xs text-mute">{l.help}</span></span>
          </label>
        ))}
      </fieldset>

      {vis === 'invite' && (
        <div className="space-y-2">
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); act(async () => { await api(`${base}/invites`, { body: { email } }); setEmail(''); }); }}>
            <label className="sr-only" htmlFor={`inv-${id}`}>Adresse à inviter</label>
            <input id={`inv-${id}`} type="email" required className="input" placeholder="adresse@exemple.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <button className="btn-primary shrink-0">Inviter</button>
          </form>
          <ul className="space-y-1 text-sm" data-testid="invites">
            {s.invites.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2 rounded-lg bg-panel-2 px-3 py-1.5">
                <span className="truncate">{i.email}</span>
                <button className="text-mute underline hover:text-text" onClick={() => act(() => api(`/api/share/invites/${i.id}`, { method: 'DELETE' }))}>Retirer</button>
              </li>
            ))}
            {!s.invites.length && <li className="text-mute">Personne n’est invité pour l’instant. L’invitation part par email avec un lien personnel.</li>}
          </ul>
        </div>
      )}

      {vis !== 'private' && vis !== 'inherit' && (
        <div className="space-y-2">
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); act(async () => { await api(`${base}/links`, { body: { label } }); setLabel(''); }); }}>
            <label className="sr-only" htmlFor={`lbl-${id}`}>Nom du lien</label>
            <input id={`lbl-${id}`} required maxLength={60} className="input" placeholder="Nom du lien (ex. Instagram, DM label)" value={label} onChange={(e) => setLabel(e.target.value)} />
            <button className="btn-ghost shrink-0" data-testid="create-link">Créer un lien</button>
          </form>
          <ul className="space-y-1 text-sm" data-testid="links">
            {activeLinks.map((l) => (
              <li key={l.id} className="flex items-center gap-2 rounded-lg bg-panel-2 px-3 py-1.5" data-testid="link-row" data-url={l.url ?? ''}>
                <span className="min-w-0 flex-1 truncate">{l.label}</span>
                <button className="text-mute underline hover:text-text" onClick={async () => { await navigator.clipboard?.writeText(l.url!).catch(() => {}); setCopied(l.id); }}>
                  {copied === l.id ? 'Copié' : 'Copier'}
                </button>
                <button className="text-mute underline hover:text-text" onClick={() => act(() => api(`/api/share/links/${l.id}`, { method: 'DELETE' }))}>Révoquer</button>
              </li>
            ))}
            {!activeLinks.length && <li className="text-mute">Crée un lien par endroit où tu le partages : les stats te diront lequel marche.</li>}
          </ul>
        </div>
      )}

      {vis !== 'private' && vis !== 'inherit' && (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); act(async () => { await api(base, { method: 'PATCH', body: { password } }); setPassword(''); }); }}>
          <label className="label" htmlFor={`pw-${id}`}>Mot de passe {s.hasPassword && <span className="normal-case text-ok">· actif</span>}</label>
          <div className="flex gap-2">
            <input id={`pw-${id}`} type="password" minLength={8} className="input" placeholder={s.hasPassword ? 'Nouveau mot de passe (8 caractères min.)' : 'Optionnel, 8 caractères min.'} value={password} onChange={(e) => setPassword(e.target.value)} />
            <button className="btn-ghost shrink-0" disabled={password.length < 8}>{s.hasPassword ? 'Changer' : 'Protéger'}</button>
          </div>
          {s.hasPassword && (
            <button type="button" className="text-sm text-mute underline hover:text-text" onClick={() => act(() => api(base, { method: 'PATCH', body: { password: null } }))}>Retirer le mot de passe</button>
          )}
        </form>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={s.allowDownload} data-testid="allow-download"
          onChange={(e) => { const v = e.target.checked; setS({ ...s, allowDownload: v }); act(() => api(base, { method: 'PATCH', body: { allowDownload: v } })); }} />
        Autoriser le téléchargement du fichier d’origine
      </label>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
    </section>
  );
}
