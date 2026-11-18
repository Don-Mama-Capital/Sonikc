import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/server/session';
import { PlayerProvider } from '@/components/player/PlayerProvider';
import { PlayerBar } from '@/components/player/PlayerBar';
import { LogoutLink } from './LogoutLink';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Reçus', robots: { index: false, follow: false } };

/** « Reçus » est ouvert à tout compte connecté, même sans profil de producteur (A&R, artiste invité). */
export default async function ReceivedLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/login?next=/recus');
  return (
    <PlayerProvider>
      <header className="sticky top-0 z-30 border-b border-line bg-ink/90 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3 sm:px-6">
          <span className="text-sm font-black uppercase tracking-[0.15em] text-accent">Sonikc</span>
          <nav className="flex min-w-0 flex-1 gap-3 text-sm text-mute">
            {user.handle && <Link href="/app" className="hover:text-text">Bibliothèque</Link>}
            <Link href="/recus" className="text-text">Reçus</Link>
          </nav>
          <LogoutLink />
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 pb-32 pt-6 sm:px-6">{children}</main>
      <PlayerBar />
    </PlayerProvider>
  );
}
