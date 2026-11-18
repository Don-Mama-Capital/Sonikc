import Link from 'next/link';
import { notFound } from 'next/navigation';
import { resolveFromCookies } from '@/lib/server/listener-http';
import { loadShared } from '@/lib/server/viewer';
import { PasswordForm, SwitchAccount } from './forms';
import { SharedView } from './SharedView';

export const metadata = { title: 'Écoute partagée' };

const Brand = () => <p className="mb-6 text-sm font-semibold uppercase tracking-[0.3em] text-accent">Sonikc</p>;

export default async function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { user, resolution: r } = await resolveFromCookies(token);
  if (r.status === 'not_found') notFound();
  if (r.status === 'login') {
    return (
      <section className="card mx-auto max-w-md space-y-4 p-6">
        <Brand />
        <h1 className="text-xl font-bold">{r.ownerName || 'Un producteur'} t’a invité à écouter</h1>
        <p className="text-sm text-mute">Ce partage est réservé aux personnes invitées. Connecte-toi avec l’adresse qui a reçu l’invitation.</p>
        <Link className="btn-primary w-full" href={`/login?next=${encodeURIComponent(`/s/${token}`)}`}>Se connecter pour écouter</Link>
      </section>
    );
  }
  if (r.status === 'denied') {
    return (
      <section className="card mx-auto max-w-md space-y-4 p-6">
        <Brand />
        <h1 className="text-xl font-bold">Partage réservé aux invités</h1>
        <p className="text-sm text-mute">Tu es connecté avec <span className="text-text">{user?.email}</span>, qui n’est pas sur la liste d’invitation.</p>
        <SwitchAccount next={`/s/${token}`} />
      </section>
    );
  }
  if (r.status === 'password') {
    return (
      <section className="card mx-auto max-w-md space-y-4 p-6">
        <Brand />
        <h1 className="text-xl font-bold">Partage protégé</h1>
        <p className="text-sm text-mute">{r.ownerName || 'Le producteur'} a protégé ce partage par un mot de passe.</p>
        <PasswordForm token={token} />
      </section>
    );
  }
  const view = await loadShared(token, r);
  if (!view) notFound();
  return (
    <>
      <Brand />
      <SharedView token={token} view={view} />
    </>
  );
}
