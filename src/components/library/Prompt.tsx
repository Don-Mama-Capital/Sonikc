'use client';

import { useState } from 'react';

/** Petit formulaire en ligne (remplace window.prompt, qui bloque les tests et le navigateur). */
export function InlinePrompt({ label, initial = '', submitLabel, onSubmit, onCancel, testId }: {
  label: string; initial?: string; submitLabel: string; onSubmit: (v: string) => Promise<void>; onCancel: () => void; testId?: string;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form data-testid={testId} className="card flex flex-wrap items-end gap-2 p-3" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setError(null);
      try { await onSubmit(value); } catch (err) { setError((err as Error).message); setBusy(false); }
    }}>
      <label className="min-w-48 flex-1">
        <span className="label">{label}</span>
        <input className="input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} maxLength={160} required />
      </label>
      <button className="btn-primary" disabled={busy}>{submitLabel}</button>
      <button type="button" className="btn-ghost" onClick={onCancel}>Annuler</button>
      {error && <p role="alert" className="w-full text-sm text-bad">{error}</p>}
    </form>
  );
}
