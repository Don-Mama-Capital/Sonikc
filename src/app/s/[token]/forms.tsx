'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function PasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const res = await fetch(`/api/s/${token}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { setError(data.error ?? 'Une erreur est survenue.'); setBusy(false); return; }
    router.refresh();
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className="label" htmlFor="share-password">Mot de passe</label>
        <input id="share-password" type="password" required className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      </div>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      <button className="btn-primary w-full" disabled={busy}>{busy ? 'Vérification…' : 'Accéder'}</button>
    </form>
  );
}

export function SwitchAccount({ next }: { next: string }) {
  return (
    <button className="btn-ghost w-full" onClick={async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = `/login?next=${encodeURIComponent(next)}`;
    }}>
      Me connecter avec une autre adresse
    </button>
  );
}
