import { cookies } from 'next/headers';
import { currentUser } from '@/lib/server/session';
import { listReceived } from '@/lib/server/saves';
import { ReceivedList } from './ReceivedList';

export default async function ReceivedPage() {
  const user = (await currentUser())!;
  const jar = await cookies();
  const items = await listReceived(user.id, (n) => jar.get(n)?.value);
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold">Reçus</h1>
        <p className="text-sm text-mute">Les partages que tu as enregistrés. Ils restent à jour, et le producteur peut les retirer à tout moment.</p>
      </header>
      <ReceivedList items={items} />
    </div>
  );
}
