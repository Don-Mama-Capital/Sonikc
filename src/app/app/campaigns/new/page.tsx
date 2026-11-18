import { notFound } from 'next/navigation';
import { withUser } from '@/lib/server/db';
import { requireUser } from '@/lib/server/session';
import { CampaignForm } from './CampaignForm';

export const metadata = { title: 'Nouvel envoi' };

export default async function NewCampaignPage({ searchParams }: { searchParams: Promise<{ kind?: string; id?: string }> }) {
  const { kind, id } = await searchParams;
  if ((kind !== 'project' && kind !== 'track') || !id || !/^[0-9a-f-]{36}$/.test(id)) notFound();
  const user = await requireUser();
  const [t] = await withUser(user.id, (tx) => kind === 'project'
    ? tx<{ title: string; visibility: string | null }[]>`select title, visibility from projects where id = ${id} and deleted_at is null`
    : tx<{ title: string; visibility: string | null }[]>`select title, visibility from tracks where id = ${id} and deleted_at is null`);
  if (!t) notFound();
  return <CampaignForm kind={kind} id={id} title={t.title} visibility={t.visibility} ownerName={user.displayName ?? user.handle ?? ''} />;
}
