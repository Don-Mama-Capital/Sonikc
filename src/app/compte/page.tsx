import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/server/session';
import { AccountView } from './AccountView';

export const metadata = { title: 'Mes données', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/** Ouvert à tout compte (producteur ou simple acheteur / auditeur connecté). */
export default async function AccountPage() {
  const user = await currentUser();
  if (!user) redirect('/login?next=/compte');
  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 pb-20 pt-8 sm:px-6">
      <Link href={user.handle ? '/app' : '/recus'} className="text-sm font-semibold uppercase tracking-[0.3em] text-accent">Sonikc</Link>
      <AccountView confirmWord={user.handle ?? user.email} />
    </main>
  );
}
