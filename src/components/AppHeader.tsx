'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { NotificationBell } from './NotificationBell';

const NEXT = { auto: 'sharps', sharps: 'flats', flats: 'auto' } as const;
const LABEL = { auto: 'Auto', sharps: '♯', flats: '♭' } as const;
const TITLE = { auto: 'écriture usuelle', sharps: 'toujours des dièses', flats: 'toujours des bémols' } as const;

const LINKS = [
  { href: '/app', label: 'Bibliothèque' },
  { href: '/app/contacts', label: 'Contacts' },
  { href: '/app/campaigns', label: 'Envois' },
  { href: '/app/boutique', label: 'Ma page' },
  { href: '/app/ventes', label: 'Ventes' },
  { href: '/app/offre', label: 'Mon offre' },
  { href: '/recus', label: 'Reçus' },
  { href: '/achats', label: 'Achats' },
  { href: '/app/trash', label: 'Corbeille' },
];

export function AppHeader({ handle, notation }: { handle: string; notation: 'auto' | 'sharps' | 'flats' }) {
  const router = useRouter();
  const path = usePathname();
  const [menu, setMenu] = useState(false);
  const current = LINKS.filter((l) => path === l.href || (l.href !== '/app' && path.startsWith(l.href))).at(-1) ?? LINKS[0];
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-ink/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-3 py-3 sm:gap-4 sm:px-6">
        <Link href="/app" className="text-sm font-black uppercase tracking-[0.15em] text-accent sm:tracking-[0.25em]">Sonikc</Link>
        <nav className="hidden min-w-0 flex-1 gap-4 text-sm text-mute lg:flex">
          {LINKS.map((l) => <Link key={l.href} href={l.href} className={`hover:text-text ${current.href === l.href ? 'text-text' : ''}`}>{l.label}</Link>)}
        </nav>
        {/* Sur mobile : un menu déroulant plutôt qu'une barre qui déborde. */}
        <div className="relative min-w-0 flex-1 lg:hidden">
          <button className="flex max-w-full items-center gap-1 truncate text-sm text-text" aria-expanded={menu} aria-haspopup="true" data-testid="menu" onClick={() => setMenu((m) => !m)}>
            {current.label} <span aria-hidden="true" className="text-mute">▾</span>
          </button>
          {menu && (
            <div className="absolute left-0 z-40 mt-2 w-48 rounded-2xl border border-line bg-panel p-1 shadow-xl">
              {LINKS.map((l) => <Link key={l.href} href={l.href} onClick={() => setMenu(false)} className="block rounded-xl px-3 py-2 text-sm hover:bg-panel-2">{l.label}</Link>)}
            </div>
          )}
        </div>
        <button className="rounded-lg border border-line px-2 py-1 font-mono text-xs text-mute hover:text-text" data-testid="notation"
          title={`Tonalités : ${TITLE[notation]} (cliquer pour changer)`} aria-label={`Notation des tonalités : ${TITLE[notation]}`}
          onClick={async () => {
            await fetch('/api/profile', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keyNotation: NEXT[notation] }) });
            router.refresh();
          }}>
          {LABEL[notation]}
        </button>
        <NotificationBell />
        <span className="hidden text-sm text-mute sm:inline" data-testid="me">@{handle}</span>
        <button className="shrink-0 text-sm text-mute underline hover:text-text" data-testid="logout"
          onClick={async () => { await fetch('/api/auth/logout', { method: 'POST' }); router.replace('/login'); router.refresh(); }}>
          <span className="hidden sm:inline">Déconnexion</span><span className="sm:hidden">Sortir</span>
        </button>
      </div>
    </header>
  );
}
