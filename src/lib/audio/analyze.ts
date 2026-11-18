import { stftMagnitudes } from './fft';
import type { Mode } from './keys';

export const ANALYSIS_SR = 22050;

/** Enveloppe de la forme d'onde : `buckets` valeurs entre 0 et 1 (crête par tranche). */
export function waveformPeaks(x: Float32Array, buckets = 800) {
  const out: number[] = new Array(buckets).fill(0);
  if (x.length === 0) return out;
  const per = x.length / buckets;
  let max = 0;
  for (let b = 0; b < buckets; b++) {
    let peak = 0;
    const end = Math.min(x.length, Math.floor((b + 1) * per));
    for (let i = Math.floor(b * per); i < end; i++) { const v = Math.abs(x[i]); if (v > peak) peak = v; }
    out[b] = peak;
    if (peak > max) max = peak;
  }
  return out.map((v) => (max > 0 ? Math.round((v / max) * 1000) / 1000 : 0));
}

/**
 * Enveloppe d'attaques (flux spectral sous 1,5 kHz) : un échantillon par saut de `hop`.
 * Les fréquences hautes (charlestons) sont ignorées : elles brouillent le tempo de base.
 */
function onsetEnvelope(x: Float32Array, sr: number) {
  const size = 1024, hop = 256;
  const fps = sr / hop;
  const cutBin = Math.round((1500 * size) / sr);
  const env: number[] = [];
  let prev: Float64Array | null = null;
  stftMagnitudes(x, size, hop, (mag) => {
    const cur = new Float64Array(mag.length);
    let flux = 0;
    for (let k = 1; k < cutBin; k++) {
      cur[k] = Math.log1p(100 * mag[k]);
      if (prev) { const d = cur[k] - prev[k]; if (d > 0) flux += d; }
    }
    env.push(flux);
    prev = cur;
  });
  // Retire la tendance locale (≈ 0,5 s) et ne garde que le positif.
  const w = Math.round(fps * 0.5);
  const o = new Float64Array(env.length);
  let acc = 0;
  for (let i = 0; i < env.length; i++) {
    acc += env[i];
    if (i >= w) acc -= env[i - w];
    const mean = acc / Math.min(i + 1, w);
    o[i] = Math.max(0, env[i] - mean);
  }
  return { o, fps };
}

/**
 * Tempo en BPM. Autocorrélation de l'enveloppe d'attaques, renforcée par ses harmoniques,
 * pondérée vers la zone 80–160 BPM, puis affinée au dixième. Rend null si le signal est trop court ou sans rythme.
 */
export function detectBpm(x: Float32Array, sr = ANALYSIS_SR): number | null {
  const { o, fps } = onsetEnvelope(x, sr);
  if (o.length < fps * 6) return null;
  const minBpm = 55, maxBpm = 210;
  const maxLag = Math.ceil((60 * fps) / minBpm) * 4 + 2;
  const ac = new Float64Array(maxLag + 1);
  const n = o.length;
  for (let l = 0; l <= maxLag && l < n; l++) {
    let s = 0;
    for (let i = 0; i + l < n; i++) s += o[i] * o[i + l];
    ac[l] = s / (n - l);
  }
  if (ac[0] <= 0) return null;
  const at = (lag: number) => {
    const i = Math.floor(lag), f = lag - i;
    if (i + 1 >= ac.length) return 0;
    return ac[i] * (1 - f) + ac[i + 1] * f;
  };
  const score = (bpm: number) => {
    const period = (60 * fps) / bpm;
    let s = 0;
    for (let k = 1; k <= 4; k++) s += at(period * k) / k;
    // Préférence douce pour les tempos usuels (log-gaussienne centrée sur 120).
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    return s * prior;
  };
  let best = 0, bestScore = -Infinity;
  for (let bpm = minBpm; bpm <= maxBpm; bpm += 0.5) {
    const s = score(bpm);
    if (s > bestScore) { bestScore = s; best = bpm; }
  }
  for (let bpm = best - 1; bpm <= best + 1; bpm += 0.05) {
    const s = score(bpm);
    if (s > bestScore) { bestScore = s; best = bpm; }
  }
  if (!(bestScore > 0)) return null;
  // Demi-tempo : si la grille rapide tombe une fois sur deux sur des attaques faibles
  // (croches de charleston en boom bap), le vrai tempo est la moitié.
  if (best >= 120 && gridMean(o, fps, best / 2) > 1.3 * gridMean(o, fps, best)) best /= 2;
  const rounded = Math.round(best);
  return Math.abs(best - rounded) < 0.35 ? rounded : Math.round(best * 10) / 10;
}

/** Force moyenne des attaques sur la meilleure grille régulière au tempo `bpm`. */
function gridMean(o: Float64Array, fps: number, bpm: number) {
  const p = (60 * fps) / bpm;
  let best = 0;
  for (let ph = 0; ph < p; ph += 0.5) {
    let s = 0, c = 0;
    for (let t = ph; t < o.length - 1; t += p) {
      const i = Math.floor(t), f = t - i;
      s += o[i] * (1 - f) + o[i + 1] * f;
      c++;
    }
    if (c && s / c > best) best = s / c;
  }
  return best;
}

// Profils de Krumhansl-Kessler (perception de la tonalité).
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a: number[], b: number[]) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Profil de chroma moyen (12 classes de hauteur), à partir des fréquences 55 Hz – 2 kHz. */
export function chroma(x: Float32Array, sr = ANALYSIS_SR) {
  const size = 8192, hop = 4096;
  const pcOfBin: number[] = [];
  for (let k = 0; k < size / 2; k++) {
    const f = (k * sr) / size;
    if (f < 55 || f > 2000) { pcOfBin.push(-1); continue; }
    const midi = 69 + 12 * Math.log2(f / 440);
    const nearest = Math.round(midi);
    // On ignore les bins trop loin d'une note (bruit des percussions).
    pcOfBin.push(Math.abs(midi - nearest) < 0.3 ? ((nearest % 12) + 12) % 12 : -1);
  }
  const total = new Array(12).fill(0);
  stftMagnitudes(x, size, hop, (mag) => {
    const frame = new Array(12).fill(0);
    let sum = 0;
    for (let k = 0; k < mag.length; k++) {
      const pc = pcOfBin[k];
      if (pc >= 0) { const v = Math.sqrt(mag[k]); frame[pc] += v; sum += v; }
    }
    if (sum > 1e-6) for (let i = 0; i < 12; i++) total[i] += frame[i] / sum;
  });
  return total;
}

export function detectKey(x: Float32Array, sr = ANALYSIS_SR): { pc: number; mode: Mode; confidence: number } | null {
  const c = chroma(x, sr);
  if (c.every((v) => v === 0)) return null;
  const results: { pc: number; mode: Mode; r: number }[] = [];
  for (let pc = 0; pc < 12; pc++) {
    const rot = (p: number[]) => p.map((_, i) => p[(i - pc + 12) % 12]);
    results.push({ pc, mode: 'major', r: pearson(c, rot(MAJOR)) });
    results.push({ pc, mode: 'minor', r: pearson(c, rot(MINOR)) });
  }
  results.sort((a, b) => b.r - a.r);
  const [best, second] = results;
  return { pc: best.pc, mode: best.mode, confidence: Math.round((best.r - second.r) * 1000) / 1000 };
}
