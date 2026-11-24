'use client';

import { useEffect, type RefObject } from 'react';
import type { QueueItem } from './PlayerProvider';
import { PAGE_VISITOR } from '@/lib/client/visitor';

const BEAT_MS = 5000;

/**
 * Mesure l'écoute d'un morceau partagé : seul le temps réellement joué compte (les sauts dans le
 * morceau sont ignorés). Un battement part toutes les 5 s, à la pause, au changement de morceau
 * et à la fermeture de la page (sendBeacon) : au plus quelques secondes peuvent être perdues.
 */
export function useListenTracker(audio: RefObject<HTMLAudioElement | null>, current: QueueItem | null) {
  useEffect(() => {
    const a = audio.current;
    const l = current?.listen;
    if (!a || !l) return;
    const url = `/api/s/${l.token}/listen`;
    let session: string | null = null;
    let starting: Promise<void> | null = null;
    let pending = 0;
    let lastPos = a.currentTime;
    let timer: ReturnType<typeof setInterval> | null = null;

    const send = (body: unknown, beacon = false) => {
      const data = JSON.stringify({ ...(body as object), pv: PAGE_VISITOR });
      if (beacon && navigator.sendBeacon) { navigator.sendBeacon(url, new Blob([data], { type: 'text/plain' })); return Promise.resolve(null); }
      return fetch(url, { method: 'POST', body: data, keepalive: true, headers: { 'content-type': 'text/plain' } })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    };
    const flush = (beacon = false) => {
      if (!session || pending < 250) return;
      const ms = Math.round(pending);
      pending = 0;
      void send({ action: 'beat', sessionId: session, playedMs: ms }, beacon);
    };
    const onTime = () => {
      const d = a.currentTime - lastPos;
      lastPos = a.currentTime;
      if (!a.paused && d > 0 && d < 1.5) pending += d * 1000;
    };
    const onSeeked = () => { lastPos = a.currentTime; };
    const onPlay = () => {
      lastPos = a.currentTime;
      if (!session && !starting) {
        starting = send({ action: 'start', trackId: l.trackId }).then((r) => { session = r?.sessionId ?? null; starting = null; });
      }
      if (!timer) timer = setInterval(() => flush(), BEAT_MS);
    };
    const onPause = () => { flush(); if (timer) clearInterval(timer); timer = null; };
    const onHide = () => flush(true);

    a.addEventListener('timeupdate', onTime);
    a.addEventListener('seeked', onSeeked);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('ended', onPause);
    window.addEventListener('pagehide', onHide);
    if (!a.paused) onPlay();
    return () => {
      flush(true);
      if (timer) clearInterval(timer);
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('seeked', onSeeked);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('ended', onPause);
      window.removeEventListener('pagehide', onHide);
    };
  }, [audio, current]);
}
