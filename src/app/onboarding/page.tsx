import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/server/session';
import { OnboardingForm } from './OnboardingForm';

export const metadata = { title: 'Ton profil' };

export default async function OnboardingPage() {
  const user = await requireUser({ allowNoProfile: true });
  if (user.handle) redirect('/app');
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-16">
      <p className="mb-8 text-sm font-semibold uppercase tracking-[0.3em] text-accent">Sonikc</p>
      <OnboardingForm />
    </main>
  );
}
