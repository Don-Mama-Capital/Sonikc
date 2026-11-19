'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { euros, FORMAT_LABEL, licenceLines } from '@/lib/licences';
import type { Template } from '@/lib/server/storefront';

type Profile = { handle: string; displayName: string; bio: string; links: Record<string, string> };
const LINKS = [['instagram', 'Instagram'], ['youtube', 'YouTube'], ['soundcloud', 'SoundCloud'], ['spotify', 'Spotify'], ['tiktok', 'TikTok'], ['site', 'Site'] ] as const;

const blank = (): Omit<Template, 'id' | 'position'> => ({
  name: '', description: '', formats: ['mp3'], maxStreams: null, maxCopies: null, musicVideos: null, radio: false, exclusive: false, priceCents: 2900, active: true,
});

/** « Ma page » : profil public et licences de vente. */
export function BoutiqueView() {
  const [p, setP] = useState<Profile | null>(null);
  const [tpls, setTpls] = useState<Template[] | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const load = useCallback(async () => {
    const [pp, tt] = await Promise.all([api<Profile>('/api/profile/public'), api<Template[]>('/api/licences')]);
    setP(pp); setTpls(tt);
  }, []);
  useEffect(() => { load().catch((e) => setMsg({ ok: false, text: e.message })); }, [load]);
  if (!p || !tpls) return <p className="text-sm text-mute">Chargement…</p>;

  const saveProfile = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const links = Object.fromEntries(LINKS.map(([k]) => [k, String(fd.get(`link-${k}`) ?? '')]));
    setMsg(null);
    try {
      await api('/api/profile/public', { method: 'PUT', body: { displayName: fd.get('displayName'), bio: fd.get('bio'), links } });
      await load(); setMsg({ ok: true, text: 'Profil enregistré.' });
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
  };

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Ma page</h1>
          <p className="text-sm text-mute">Ce que tout le monde voit à l’adresse <span className="text-text">/{p.handle}</span> : tes morceaux « Public » et « En vente ».</p>
        </div>
        <a className="btn-ghost" href={`/${p.handle}`} target="_blank" rel="noopener" data-testid="open-store">Voir ma page</a>
      </header>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`text-sm ${msg.ok ? 'text-ok' : 'text-bad'}`}>{msg.text}</p>}

      <form className="card space-y-4 p-4" onSubmit={saveProfile} aria-label="Profil public">
        <h2 className="text-lg font-semibold">Profil</h2>
        <label className="block"><span className="label">Nom affiché</span><input className="input" name="displayName" defaultValue={p.displayName} maxLength={60} required /></label>
        <label className="block"><span className="label">Présentation</span><textarea className="input min-h-24" name="bio" defaultValue={p.bio} maxLength={500} /></label>
        <div className="grid gap-3 sm:grid-cols-2">
          {LINKS.map(([k, label]) => (
            <label key={k} className="block"><span className="label">{label}</span>
              <input className="input" name={`link-${k}`} defaultValue={p.links[k] ?? ''} maxLength={200} placeholder="https://…" inputMode="url" /></label>
          ))}
        </div>
        <button className="btn-primary" type="submit">Enregistrer le profil</button>
      </form>

      <section className="space-y-3" aria-label="Licences">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Licences</h2>
            <p className="text-sm text-mute">Proposées sur chaque morceau « En vente ». Prix hors taxes : la TVA du pays de l’acheteur s’ajoute au paiement.</p>
          </div>
          <button className="btn-ghost" onClick={() => setEditing('new')} disabled={editing !== null}>Ajouter</button>
        </div>
        {editing === 'new' && <TemplateForm initial={blank()} onCancel={() => setEditing(null)}
          onSave={async (t) => { await api('/api/licences', { body: t }); setEditing(null); await load(); }} />}
        <ul className="space-y-3" data-testid="templates">
          {tpls.map((t) => editing === t.id ? (
            <li key={t.id}><TemplateForm initial={t} onCancel={() => setEditing(null)}
              onSave={async (v) => { await api(`/api/licences/${t.id}`, { method: 'PUT', body: v }); setEditing(null); await load(); }} /></li>
          ) : (
            <li key={t.id} className={`card p-4 ${t.active ? '' : 'opacity-60'}`} data-testid="template">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-semibold">{t.name}{!t.active && <span className="ml-2 text-xs text-mute">désactivée</span>}</p>
                <p className="font-semibold">{euros(t.priceCents)} HT</p>
              </div>
              {t.description && <p className="mt-1 text-sm text-mute">{t.description}</p>}
              <ul className="mt-2 space-y-0.5 text-sm">{licenceLines(t).map((l) => <li key={l}>{l}</li>)}</ul>
              {t.formats.includes('stems') && <p className="mt-2 text-xs text-warn">Les stems ne sont pas encore livrés automatiquement : cette licence n’est pas affichée à l’achat.</p>}
              <div className="mt-3 flex gap-3 text-sm">
                <button className="text-mute underline hover:text-text" onClick={() => setEditing(t.id)} disabled={editing !== null}>Modifier</button>
                <button className="text-mute underline hover:text-text" onClick={async () => {
                  await api(`/api/licences/${t.id}`, { method: 'PUT', body: { ...t, active: !t.active } }); await load();
                }}>{t.active ? 'Désactiver' : 'Réactiver'}</button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

type Draft = Omit<Template, 'id' | 'position'>;

function TemplateForm({ initial, onSave, onCancel }: { initial: Draft; onSave: (t: Draft) => Promise<void>; onCancel: () => void }) {
  const [t, setT] = useState<Draft>({ ...initial });
  const [error, setError] = useState<string | null>(null);
  const num = (v: string) => (v.trim() === '' ? null : Math.max(0, Math.round(Number(v))));
  return (
    <form className="card space-y-3 p-4" data-testid="template-form" onSubmit={async (e) => {
      e.preventDefault(); setError(null);
      try { await onSave(t); } catch (err) { setError((err as Error).message); }
    }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block"><span className="label">Nom</span><input className="input" value={t.name} maxLength={60} required onChange={(e) => setT({ ...t, name: e.target.value })} /></label>
        <label className="block"><span className="label">Prix HT (€)</span><input className="input" type="number" min={1} step="0.01" required inputMode="decimal"
          value={t.priceCents / 100} onChange={(e) => setT({ ...t, priceCents: Math.round(Number(e.target.value) * 100) })} /></label>
      </div>
      <label className="block"><span className="label">Description</span><textarea className="input" value={t.description} maxLength={1000} onChange={(e) => setT({ ...t, description: e.target.value })} /></label>
      <fieldset><legend className="label">Fichiers livrés</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {Object.entries(FORMAT_LABEL).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={t.formats.includes(k as never)}
              onChange={(e) => setT({ ...t, formats: e.target.checked ? [...t.formats, k as never] : t.formats.filter((f) => f !== k) })} />{label}</label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block"><span className="label">Écoutes en streaming max</span><input className="input" type="number" min={1} placeholder="Illimité" value={t.maxStreams ?? ''} onChange={(e) => setT({ ...t, maxStreams: num(e.target.value) })} /></label>
        <label className="block"><span className="label">Ventes ou téléchargements max</span><input className="input" type="number" min={1} placeholder="Illimité" value={t.maxCopies ?? ''} onChange={(e) => setT({ ...t, maxCopies: num(e.target.value) })} /></label>
        <label className="block"><span className="label">Clips</span><input className="input" type="number" min={0} placeholder="Illimité" value={t.musicVideos ?? ''} onChange={(e) => setT({ ...t, musicVideos: num(e.target.value) })} /></label>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={t.radio} onChange={(e) => setT({ ...t, radio: e.target.checked })} />Diffusion radio autorisée</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={t.exclusive} onChange={(e) => setT({ ...t, exclusive: e.target.checked })} />Exclusive (retire le morceau de la vente après l’achat)</label>
      </div>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      <div className="flex gap-2"><button className="btn-primary" type="submit" disabled={!t.formats.length}>Enregistrer</button><button type="button" className="btn-ghost" onClick={onCancel}>Annuler</button></div>
    </form>
  );
}
