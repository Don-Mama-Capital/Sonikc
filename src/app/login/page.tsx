import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/server/session';
import { LoginForm } from './LoginForm';
import { googleConfig, safeNext } from '@/lib/server/google';

const ERRORS: Record<string, string> = {
  google_email_unverified: 'Ton adresse Google n’est pas vérifiée. Utilise la connexion par code.',
  google_conflict: 'Cette adresse est déjà liée à un autre compte Google.',
  google_bad_state: 'La connexion Google a expiré. Recommence.',
  google_expired: 'La connexion Google a expiré. Recommence.',
};

export const metadata = { title: 'Connexion' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  const next = safeNext(q.next);
  const user = await currentUser();
  if (user) redirect(next ?? (user.handle ? '/app' : '/onboarding'));
  const error = q.error ? ERRORS[q.error] ?? 'La connexion Google a échoué. Réessaie ou utilise la connexion par code.' : null;
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-16">
      <p className="mb-8 text-sm font-semibold uppercase tracking-[0.3em] text-accent">Sonikc</p>
      <LoginForm next={next} google={Boolean(googleConfig())} error={error} />
    </main>
  );
}
