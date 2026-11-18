'use client';

export function LogoutLink() {
  return (
    <button className="shrink-0 text-sm text-mute underline hover:text-text"
      onClick={async () => { await fetch('/api/auth/logout', { method: 'POST' }); window.location.href = '/login'; }}>
      Sortir
    </button>
  );
}
