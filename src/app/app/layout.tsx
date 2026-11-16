import { requireUser } from '@/lib/server/session';
import { AppHeader } from '@/components/AppHeader';
import { PlayerProvider } from '@/components/player/PlayerProvider';
import { PlayerBar } from '@/components/player/PlayerBar';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <PlayerProvider>
      <AppHeader handle={user.handle!} notation={user.keyNotation} />
      <main className="mx-auto max-w-6xl px-4 pb-32 pt-5 sm:px-6">{children}</main>
      <PlayerBar />
    </PlayerProvider>
  );
}
