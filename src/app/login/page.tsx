import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/server/session';
import { LoginForm } from './LoginForm';

export const metadata = { title: 'Connexion' };

export default async function LoginPage() {
  const user = await currentUser();
  if (user) redirect(user.handle ? '/app' : '/onboarding');
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-16">
      <p className="mb-8 text-sm font-semibold uppercase tracking-[0.3em] text-accent">Sonikc</p>
      <LoginForm />
    </main>
  );
}
