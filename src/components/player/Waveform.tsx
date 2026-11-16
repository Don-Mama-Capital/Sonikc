'use client';

import { useEffect, useRef } from 'react';

/** Forme d'onde dessinée sur canvas ; la partie jouée est en couleur. Clic ou tap = aller à ce moment. */
export function Waveform({ peaks, progress, onSeek, height = 40, className = '' }: {
  peaks: number[] | null; progress: number; onSeek?: (f: number) => void; height?: number; className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    c.width = w * dpr; c.height = height * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, height);
    const data = peaks?.length ? peaks : new Array(200).fill(0.15);
    const bars = Math.max(1, Math.floor(w / 3));
    for (let i = 0; i < bars; i++) {
      const v = data[Math.floor((i / bars) * data.length)] ?? 0;
      const h = Math.max(2, v * (height - 4));
      g.fillStyle = i / bars < progress ? '#ff5a36' : '#3a3a48';
      g.fillRect(i * 3, (height - h) / 2, 2, h);
    }
  }, [peaks, progress, height]);
  return (
    <canvas
      ref={ref}
      style={{ height }}
      className={`w-full ${onSeek ? 'cursor-pointer' : ''} ${className}`}
      onClick={(e) => {
        if (!onSeek) return;
        const r = e.currentTarget.getBoundingClientRect();
        onSeek((e.clientX - r.left) / r.width);
      }}
      aria-hidden
    />
  );
}
