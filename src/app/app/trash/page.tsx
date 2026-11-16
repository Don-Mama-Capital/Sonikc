import { requireUser } from '@/lib/server/session';
import { listTrash } from '@/lib/server/library';
import { TrashView } from './TrashView';

export const metadata = { title: 'Corbeille' };

export default async function TrashPage() {
  const user = await requireUser();
  return <TrashView tracks={await listTrash(user.id)} />;
}
