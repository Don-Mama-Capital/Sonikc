'use client';

import { useState } from 'react';
import { ConsentReopen } from '@/components/legal/ConsentBanner';

/** « Mes données » : export, cookies, suppression du compte. */
export function AccountView({ confirmWord }: { confirmWord: string }) {
  const [confirm, setConfirm] = useState('');
  const [owed, setOwed] = useState<number | null>(null);
  const [renounce, setRenounce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Mes données</h1>

      <section className="card space-y-2 p-5">
        <h2 className="text-lg font-semibold">Télécharger mes données</h2>
        <p className="text-sm text-mute">Un fichier JSON avec ton compte, tes morceaux (sans les fichiers audio), partages, écoutes, contacts, envois, ventes et achats.</p>
        <a className="btn-ghost inline-block" href="/api/account/export" data-testid="export">Télécharger (JSON)</a>
      </section>

      <section className="card space-y-2 p-5">
        <h2 className="text-lg font-semibold">Cookies</h2>
        <p className="text-sm text-mute">Change ton choix sur le cookie de mesure d’écoute. <a className="underline" href="/cookies">Détail des cookies</a></p>
        <ConsentReopen className="btn-ghost" />
      </section>

      <section className="card space-y-3 border-bad/40 p-5" data-testid="delete-account">
        <h2 className="text-lg font-semibold">Supprimer mon compte</h2>
        <ul className="space-y-1 text-sm">
          <li>Effacés : tes morceaux et leurs fichiers, dossiers, partages, statistiques, contacts, envois, licences, ton profil et ta connexion.</li>
          <li>Gardés pour la loi, sans ton email ni ton profil : tes ventes et factures (10 ans), les parts dues à tes collaborateurs, les achats déjà livrés à tes clients.</li>
          <li>Un abonnement en cours est arrêté tout de suite.</li>
        </ul>
        <p className="text-sm">C’est définitif. Pense à télécharger tes données avant.</p>
        <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => {
          e.preventDefault(); setBusy(true); setError(null);
          const res = await fetch('/api/account/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm, renounceCents: renounce && owed !== null ? owed : undefined }) });
          if (res.ok) { window.location.href = '/?compte=supprime'; return; }
          const b = await res.json().catch(() => ({}));
          setBusy(false); setError(b.error ?? 'La suppression a échoué.');
          if (typeof b.owedCents === 'number') { setOwed(b.owedCents); setRenounce(false); }
        }}>
          <label className="block text-sm"><span className="text-mute">Tape <strong className="text-text">{confirmWord}</strong> pour confirmer</span>
            <input className="input mt-1" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" data-testid="delete-confirm" /></label>
          {owed !== null && (
            <label className="flex w-full items-start gap-2 text-sm">
              <input type="checkbox" checked={renounce} onChange={(e) => setRenounce(e.target.checked)} data-testid="delete-renounce" />
              <span>Je renonce à {new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(owed / 100)} de ventes et je supprime mon compte quand même.</span>
            </label>
          )}
          <button className="btn-ghost text-bad" type="submit" disabled={busy || confirm.trim().toLowerCase() !== confirmWord.toLowerCase() || (owed !== null && !renounce)} data-testid="delete-go">
            {busy ? 'Suppression…' : 'Supprimer définitivement'}
          </button>
        </form>
        {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      </section>
    </div>
  );
}
