'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export type QueueItem = { id: string; title: string; url: string; waveform: number[] | null; durationMs: number | null; subtitle?: string };

type PlayerState = {
  queue: QueueItem[];
  index: number;
  current: QueueItem | null;
  playing: boolean;
  time: number;
  duration: number;
  playList: (items: QueueItem[], start?: number) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (fraction: number) => void;
};

const Ctx = createContext<PlayerState | null>(null);

export const usePlayer = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('usePlayer hors de PlayerProvider');
  return c;
};

/**
 * Lecteur unique de l'app. Il vit dans le layout de /app : changer de page ne coupe pas le son.
 */
export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const current = index >= 0 ? queue[index] ?? null : null;

  useEffect(() => {
    const a = audio.current;
    if (!a || !current) return;
    if (a.dataset.id !== current.id) {
      a.dataset.id = current.id;
      a.src = current.url;
      setTime(0);
      setDuration(current.durationMs ? current.durationMs / 1000 : 0);
    }
    a.play().catch(() => setPlaying(false));
  }, [current]);

  const playList = useCallback((items: QueueItem[], start = 0) => {
    if (!items.length) return;
    setQueue(items);
    setIndex(start);
    if (audio.current && items[start]?.id === audio.current.dataset.id) audio.current.play().catch(() => {});
  }, []);

  const toggle = useCallback(() => {
    const a = audio.current;
    if (!a || !current) return;
    if (a.paused) a.play().catch(() => {}); else a.pause();
  }, [current]);

  const next = useCallback(() => setIndex((i) => (i + 1 < queue.length ? i + 1 : i)), [queue.length]);
  const prev = useCallback(() => {
    const a = audio.current;
    if (a && a.currentTime > 3) { a.currentTime = 0; return; }
    setIndex((i) => (i > 0 ? i - 1 : i));
  }, []);
  const seek = useCallback((f: number) => {
    const a = audio.current;
    if (a && Number.isFinite(a.duration)) a.currentTime = Math.max(0, Math.min(1, f)) * a.duration;
  }, []);

  const value = useMemo(() => ({ queue, index, current, playing, time, duration, playList, toggle, next, prev, seek }),
    [queue, index, current, playing, time, duration, playList, toggle, next, prev, seek]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <audio
        ref={audio}
        data-testid="audio"
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
        onEnded={() => (index + 1 < queue.length ? setIndex(index + 1) : setPlaying(false))}
      />
    </Ctx.Provider>
  );
}
