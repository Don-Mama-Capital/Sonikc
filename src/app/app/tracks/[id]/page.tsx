import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/server/session';
import { getTrack, NotFound } from '@/lib/server/library';
import { TrackDetail } from './TrackDetail';

export default async function TrackPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  try {
    const data = await getTrack(user.id, id);
    return <TrackDetail data={data} notation={user.keyNotation} />;
  } catch (e) {
    if (e instanceof NotFound || (e as Error).name === 'ZodError') notFound();
    throw e;
  }
}
