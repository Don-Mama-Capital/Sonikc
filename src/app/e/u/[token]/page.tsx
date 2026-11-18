import { notFound } from 'next/navigation';
import { parseSendToken } from '@/lib/server/email-token';

export const metadata = { title: 'Désinscription', robots: { index: false, follow: false } };

export default async function UnsubscribePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ ok?: string }> }) {
  const { token } = await params;
  if (!parseSendToken(token)) notFound();
  const done = (await searchParams).ok === '1';
  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <section className="card space-y-4 p-6">
        <p className="text-sm font-semibold uppercase tracking-[0.3em] text-accent">Sonikc</p>
        {done ? (
          <>
            <h1 className="text-xl font-bold" data-testid="unsub-done">C’est fait</h1>
            <p className="text-sm text-mute">Tu ne recevras plus d’emails de ce producteur via Sonikc.</p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-bold">Ne plus recevoir ses emails</h1>
            <p className="text-sm text-mute">Un clic suffit. Ce producteur ne pourra plus t’écrire via Sonikc.</p>
            <form method="post" action={`/api/e/u/${token}`}>
              <button className="btn-primary w-full">Me désinscrire</button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
