import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/server/session';
import { getProject, NotFound } from '@/lib/server/library';
import { ProjectView } from './ProjectView';

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  try {
    return <ProjectView data={await getProject(user.id, id)} notation={user.keyNotation} />;
  } catch (e) {
    if (e instanceof NotFound || (e as Error).name === 'ZodError') notFound();
    throw e;
  }
}
