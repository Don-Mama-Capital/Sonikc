'use client';

import { useEffect, useState } from 'react';

/** Bandeau cookies : « Refuser » et « Accepter » au même niveau ; rouvrable depuis la page Cookies. */
export function ConsentBanner({ initial }: { initial: string | null }) {
  const [open, setOpen] = useState(!initial);
  useEffect(() => {
    const reopen = () => setOpen(true);
    window.addEventListener('sonikc:consent', reopen);
    return () => window.removeEventListener('sonikc:consent', reopen);
  }, []);
  if (!open) return null;
  const choose = async (choice: 'accepted' | 'refused') => {
    await fetch('/api/consent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choice }) }).catch(() => {});
    setOpen(false);
    window.dispatchEvent(new CustomEvent('sonikc:consent-changed', { detail: choice }));
  };
  return (
    <div role="dialog" aria-label="Cookies" aria-live="polite" data-testid="consent"
      className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-xl rounded-2xl border border-line bg-panel p-4 shadow-2xl sm:bottom-5">
      <p className="text-sm">
        Un seul cookie de mesure, gardé sur ton appareil. Si tu acceptes, le producteur sait que c’est toi qui reviens écouter :
        tes réécoutes ne gonflent pas ses chiffres. Si tu refuses, tu écoutes pareil et rien n’est gardé sur ton appareil.{' '}
        <a href="/cookies" className="underline">En savoir plus</a>
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button className="btn-ghost" onClick={() => choose('refused')} data-testid="consent-refuse">Refuser</button>
        <button className="btn-ghost" onClick={() => choose('accepted')} data-testid="consent-accept">Accepter</button>
      </div>
    </div>
  );
}

/** Rouvre le bandeau (lien « Modifier mes choix »). */
export function ConsentReopen({ className }: { className?: string }) {
  return <button className={className} onClick={() => window.dispatchEvent(new Event('sonikc:consent'))} data-testid="consent-reopen">Modifier mes choix</button>;
}
