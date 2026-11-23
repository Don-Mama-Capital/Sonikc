import Link from 'next/link';
import { currentUser } from '@/lib/server/session';

export default async function Home() {
  const user = await currentUser();
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-8 px-6 py-16">
      <p className="text-sm font-semibold uppercase tracking-[0.3em] text-accent">Sonikc</p>
      <h1 className="text-4xl font-black leading-tight sm:text-6xl">Tes beats au même endroit. Tu sais qui les écoute.</h1>
      <p className="max-w-xl text-lg text-mute">Range tes prods, partage-les avec un lien, vois qui appuie sur play. Gratuit pour les artistes qui écoutent.</p>
      <div className="flex gap-3">
        <Link href={user ? '/app' : '/login'} className="btn-primary">{user ? 'Ouvrir ma bibliothèque' : 'Commencer'}</Link>
        <Link href="/tarifs" className="btn-ghost">Tarifs</Link>
      </div>
    </main>
  );
}
