'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { NotificationBell } from './NotificationBell';

const NEXT = { auto: 'sharps', sharps: 'flats', flats: 'auto' } as const;
const LABEL = { auto: 'Auto', sharps: '♯', flats: '♭' } as const;
const TITLE = { auto: 'écriture usuelle', sharps: 'toujours des dièses', flats: 'toujours des bémols' } as const;

export function AppHeader({ handle, notation }: { handle: string; notation: 'auto' | 'sharps' | 'flats' }) {
  const router = useRouter();
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-ink/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-3 py-3 sm:gap-4 sm:px-6">
        <Link href="/app" className="text-sm font-black uppercase tracking-[0.15em] text-accent sm:tracking-[0.25em]">Sonikc</Link>
        <nav className="flex min-w-0 flex-1 gap-3 overflow-x-auto whitespace-nowrap text-sm text-mute">
          <Link href="/app" className="hover:text-text">Bibliothèque</Link>
          <Link href="/recus" className="hover:text-text">Reçus</Link>
          <Link href="/app/trash" className="hover:text-text">Corbeille</Link>
        </nav>
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
