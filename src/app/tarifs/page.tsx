import Link from 'next/link';
import { currentUser } from '@/lib/server/session';
import { PricingTable } from './PricingTable';

export const metadata = { title: 'Tarifs', description: 'Les offres de Sonikc : prix, limites et commission sur les ventes.' };
export const dynamic = 'force-dynamic';

/** Page tarifs : entièrement générée depuis le fichier des offres (src/config/offers.ts). */
export default async function PricingPage() {
  const user = await currentUser();
  return (
    <main className="mx-auto max-w-5xl space-y-8 px-4 pb-20 pt-10 sm:px-6">
      <header className="space-y-2">
        <Link href="/" className="text-sm font-semibold uppercase tracking-[0.3em] text-accent">Sonikc</Link>
        <h1 className="text-3xl font-black sm:text-4xl">Tarifs</h1>
        <p className="text-mute">Commence gratuitement. Change d’offre ou arrête quand tu veux : tes morceaux restent à toi.</p>
      </header>
      <PricingTable loggedIn={Boolean(user)} />
    </main>
  );
}
