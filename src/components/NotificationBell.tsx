'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { notifications } from '@/lib/server/listening';

type Data = Awaited<ReturnType<typeof notifications>>;
const VERB: Record<string, [string, string]> = {
  listen: ['écoute', 'ont écouté'], download: ['a téléchargé', 'ont téléchargé'],
  favorite: ['a mis en favori', 'ont mis en favori'], save: ['a enregistré', 'ont enregistré'],
};

/** Cloche des notifications : interrogée toutes les 4 s, donc une écoute apparaît en moins de 10 s. */
export function NotificationBell() {
  const [d, setD] = useState<Data | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetch('/api/notifications').then((r) => (r.ok ? r.json() : null)).then((x) => alive && x && setD(x)).catch(() => {});
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const unread = d?.unread ?? 0;
  return (
    <div className="relative" ref={box}>
      <button className="relative grid size-8 shrink-0 place-items-center rounded-lg border border-line text-sm hover:bg-panel-2" data-testid="bell"
        aria-label={unread ? `Notifications : ${unread} nouvelle${unread > 1 ? 's' : ''}` : 'Notifications'} aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          if (!open && unread) { fetch('/api/notifications/read', { method: 'POST' }).catch(() => {}); setD((x) => (x ? { ...x, unread: 0 } : x)); }
        }}>
        <span aria-hidden="true">🔔</span>
        {unread > 0 && <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-accent px-1 text-center text-xs font-bold text-ink" data-testid="bell-count">{unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-2xl border border-line bg-panel p-2 shadow-xl" data-testid="notifications">
          {d?.items.length ? d.items.map((n) => (
            <Link key={n.id} href={n.trackId ? `/app/tracks/${n.trackId}` : n.projectId ? `/app/projects/${n.projectId}` : '/app'} onClick={() => setOpen(false)}
              className={`block rounded-xl px-3 py-2 text-sm hover:bg-panel-2 ${n.read ? 'text-mute' : ''}`} data-testid="notification">
              <span className="font-medium text-text">{n.actor ?? 'Quelqu’un'}</span>
              {n.count > 1 ? ` et ${n.count - 1} autre${n.count > 2 ? 's' : ''} personne${n.count > 2 ? 's' : ''} ${VERB[n.kind]?.[1] ?? n.kind}` : ` ${VERB[n.kind]?.[0] ?? n.kind}`}{' '}
              <span className="text-text">« {n.title ?? 'un partage'} »</span>
              <span className="block text-xs text-mute">{n.source ? `via ${n.source} · ` : ''}{new Date(n.createdAt).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
            </Link>
          )) : <p className="px-3 py-2 text-sm text-mute">Rien pour l’instant. Tu seras prévenu dès qu’on écoute un de tes liens.</p>}
        </div>
      )}
    </div>
  );
}
