import { PlayerProvider } from '@/components/player/PlayerProvider';
import { PlayerBar } from '@/components/player/PlayerBar';

export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false, follow: false } };

export default function SharedLayout({ children }: { children: React.ReactNode }) {
  return (
    <PlayerProvider>
      <main className="mx-auto max-w-3xl px-4 pb-32 pt-8 sm:px-6">{children}</main>
      <PlayerBar />
    </PlayerProvider>
  );
}
