'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function LoginForm() {
  const router = useRouter();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(url: string, body: unknown) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? 'Une erreur est survenue.');
    return data;
  }

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { await post('/api/auth/request-code', { email }); setStep('code'); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { const r = await post('/api/auth/verify', { email, code }); router.replace(r.next); router.refresh(); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  }

  if (step === 'email') {
    return (
      <form onSubmit={sendCode} className="space-y-4">
        <h1 className="text-2xl font-bold">Connexion</h1>
        <p className="text-sm text-mute">Pas de mot de passe : on t’envoie un code par email.</p>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" name="email" type="email" required autoComplete="email" className="input"
            value={email} onChange={(e) => setEmail(e.target.value)} placeholder="toi@exemple.com" />
        </div>
        {error && <p role="alert" className="text-sm text-bad">{error}</p>}
        <button className="btn-primary w-full" disabled={busy}>{busy ? 'Envoi…' : 'Recevoir un code'}</button>
      </form>
    );
  }

  return (
    <form onSubmit={verify} className="space-y-4">
      <h1 className="text-2xl font-bold">Entre ton code</h1>
      <p className="text-sm text-mute">Envoyé à <span className="text-text">{email}</span>. Il expire dans 10 minutes.</p>
      <div>
        <label className="label" htmlFor="code">Code à 6 chiffres</label>
        <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" required maxLength={7}
          className="input text-center font-mono text-2xl tracking-[0.5em]" value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, ''))} autoFocus />
      </div>
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      <button className="btn-primary w-full" disabled={busy || code.length !== 6}>{busy ? 'Vérification…' : 'Se connecter'}</button>
      <button type="button" className="w-full text-sm text-mute underline" onClick={() => { setStep('email'); setCode(''); setError(null); }}>
        Changer d’adresse ou renvoyer un code
      </button>
    </form>
  );
}
