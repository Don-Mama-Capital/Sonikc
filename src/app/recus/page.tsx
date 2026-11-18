import { cookies } from 'next/headers';
import { currentUser } from '@/lib/server/session';
import { listReceived } from '@/lib/server/saves';
import { ReceivedList } from './ReceivedList';

export default async function ReceivedPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { page } = await searchParams;
  const user = (await currentUser())!;
  const jar = await cookies();
  const res = await listReceived(user.id, (n) => jar.get(n)?.value, Number(page ?? 0));
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold">Reçus</h1>
        <p className="text-sm text-mute">Les partages que tu as enregistrés. Ils restent à jour, et le producteur peut les retirer à tout moment.</p>
      </header>
      <ReceivedList items={res.items} />
      <nav className="flex justify-between text-sm" aria-label="Pages">
        {res.page > 0 ? <a className="text-mute underline hover:text-text" href={`/recus?page=${res.page - 1}`}>← Plus récents</a> : <span />}
        {res.hasMore && <a className="text-mute underline hover:text-text" href={`/recus?page=${res.page + 1}`}>Plus anciens →</a>}
      </nav>
    </div>
  );
}
