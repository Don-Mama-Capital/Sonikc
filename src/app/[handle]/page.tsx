import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { formatKey } from '@/lib/audio/keys';
import { storefront } from '@/lib/server/storefront';
import { paymentsEnabled } from '@/lib/server/stripe';
import { currentUser } from '@/lib/server/session';
import { COUNTRIES } from '@/config/vat';
import { StoreView } from './StoreView';

type Props = { params: Promise<{ handle: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params;
  const page = await storefront(decodeURIComponent(handle)).catch(() => null);
  if (!page) return { title: 'Introuvable' };
  return { title: page.profile.displayName || page.profile.handle, description: page.profile.bio.slice(0, 160) || `Les beats de ${page.profile.displayName}` };
}

const KEYS = (['major', 'minor'] as const).flatMap((mode) => Array.from({ length: 12 }, (_, pc) => ({ value: `${pc}-${mode}`, label: formatKey(pc, mode, 'auto')! })));

const LINK_LABEL: Record<string, string> = { instagram: 'Instagram', youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify', tiktok: 'TikTok', site: 'Site' };

export default async function StorePage({ params, searchParams }: Props) {
  const { handle } = await params;
  const sp = await searchParams;
  const f = { q: one(sp.q), bpmMin: one(sp.bpmMin), bpmMax: one(sp.bpmMax), key: one(sp.key), priceMax: one(sp.priceMax), project: one(sp.project) };
  const page = await storefront(decodeURIComponent(handle), f);
  if (!page) notFound();
  const { profile, projects, tracks } = page;
  const filtered = Object.values(f).some(Boolean);
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-sm font-semibold uppercase tracking-[0.3em] text-accent">Sonikc</p>
        <h1 className="text-3xl font-black" data-testid="store-name">{profile.displayName || profile.handle}</h1>
        <p className="text-sm text-mute">@{profile.handle}</p>
        {profile.bio && <p className="whitespace-pre-line text-sm" data-testid="store-bio">{profile.bio}</p>}
        {Object.keys(profile.links).length > 0 && (
          <ul className="flex flex-wrap gap-3 text-sm">
            {Object.entries(profile.links).map(([k, url]) => (
              <li key={k}><a className="text-mute underline hover:text-text" href={url} target="_blank" rel="nofollow noopener noreferrer ugc">{LINK_LABEL[k] ?? 'Lien'}</a></li>
            ))}
          </ul>
        )}
      </header>

      <form className="card grid grid-cols-2 gap-3 p-4 sm:grid-cols-3" method="get" role="search" aria-label="Filtrer les morceaux">
        <label className="col-span-2 space-y-1 text-sm sm:col-span-3">
          <span className="text-mute">Recherche</span>
          <input className="input w-full" name="q" defaultValue={f.q} placeholder="Titre ou tag" maxLength={80} />
        </label>
        <label className="space-y-1 text-sm"><span className="text-mute">BPM min</span>
          <input className="input w-full" name="bpmMin" type="number" min={20} max={300} inputMode="numeric" defaultValue={f.bpmMin} /></label>
        <label className="space-y-1 text-sm"><span className="text-mute">BPM max</span>
          <input className="input w-full" name="bpmMax" type="number" min={20} max={300} inputMode="numeric" defaultValue={f.bpmMax} /></label>
        <label className="space-y-1 text-sm"><span className="text-mute">Tonalité</span>
          <select className="input w-full" name="key" defaultValue={f.key}>
            <option value="">Toutes</option>
            {KEYS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select></label>
        <label className="space-y-1 text-sm"><span className="text-mute">Prix max (€)</span>
          <input className="input w-full" name="priceMax" type="number" min={0} step={1} inputMode="numeric" defaultValue={f.priceMax} /></label>
        {projects.length > 0 && (
          <label className="space-y-1 text-sm"><span className="text-mute">Projet</span>
            <select className="input w-full" name="project" defaultValue={f.project}>
              <option value="">Tous</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select></label>
        )}
        <div className="col-span-2 flex items-end gap-2 sm:col-span-1">
          <button className="btn-primary flex-1" type="submit">Filtrer</button>
          {filtered && <a className="btn-ghost" href={`/${profile.handle}`}>Effacer</a>}
        </div>
      </form>

      <StoreView ownerName={profile.displayName || profile.handle} tracks={tracks} filtered={filtered}
        canBuy={paymentsEnabled()} countries={COUNTRIES} buyerEmail={(await currentUser())?.email ?? null} />
    </div>
  );
}
