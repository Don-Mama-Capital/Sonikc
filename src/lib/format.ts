export function formatDuration(ms: number | null | undefined) {
  if (!ms && ms !== 0) return '–';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function formatBytes(n: number | null | undefined) {
  if (!n) return '–';
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} Ko`;
  return `${(n / 1024 ** 2).toFixed(1).replace('.', ',')} Mo`;
}

export function formatBpm(bpm: number | null | undefined) {
  return bpm == null ? null : `${Number.isInteger(bpm) ? bpm : bpm.toFixed(1).replace('.', ',')} BPM`;
}
