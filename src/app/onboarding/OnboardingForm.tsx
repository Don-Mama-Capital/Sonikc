'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function OnboardingForm() {
  const router = useRouter();
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const res = await fetch('/api/profile', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle, displayName }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setError(data.error ?? 'Une erreur est survenue.'); setBusy(false); return; }
    router.replace('/app'); router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="text-2xl font-bold">Ton profil</h1>
      <p className="text-sm text-mute">Ton identifiant sera l’adresse de ta page : sonikc.app/<span className="text-text">{handle || 'tonnom'}</span></p>
      <div>
        <label className="label" htmlFor="displayName">Nom d’artiste</label>
        <input id="displayName" className="input" required maxLength={60} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="handle">Identifiant</label>
        <input id="handle" className="input" required maxLength={31} value={handle}
          onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_.]/g, ''))} placeholder="prodbyexemple" />
      </div>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      <button className="btn-primary w-full" disabled={busy}>{busy ? 'Création…' : 'Créer mon profil'}</button>
    </form>
  );
}
