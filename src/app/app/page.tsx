import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/server/session';
import { browse, Invalid, NotFound } from '@/lib/server/library';
import { LibraryView } from '@/components/library/LibraryView';

export const metadata = { title: 'Bibliothèque' };

export default async function LibraryPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  try {
    const data = await browse(user.id, {
      folderId: sp.folder || null, q: sp.q, bpmMin: sp.bpmMin as never, bpmMax: sp.bpmMax as never, key: sp.key, tag: sp.tag,
    });
    return <LibraryView data={data} notation={user.keyNotation} />;
  } catch (e) {
    if (e instanceof NotFound) notFound();
    if (e instanceof Invalid || (e as Error).name === 'ZodError') {
      return <p role="alert" className="text-bad">{e instanceof Invalid ? e.message : 'Filtre invalide.'} <a href="/app" className="underline">Revenir</a></p>;
    }
    throw e;
  }
}
