import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { convert } from '../src/lib/server/ffmpeg';

/**
 * Génère 10 beats de référence au tempo et à la tonalité connus, dans 4 formats.
 * Synthèse simple : kick, snare, charleston, basse et accords. Sert aux tests de détection.
 */

export type Fixture = { file: string; bpm: number; pc: number; mode: 'major' | 'minor'; style: 'trap' | 'boombap' | 'house' };

export const FIXTURES: Fixture[] = [
  { file: 'ref01_140_Amin.wav', bpm: 140, pc: 9, mode: 'minor', style: 'trap' },
  { file: 'ref02_90_Cmaj.mp3', bpm: 90, pc: 0, mode: 'major', style: 'boombap' },
  { file: 'ref03_128_F#min.flac', bpm: 128, pc: 6, mode: 'minor', style: 'house' },
  { file: 'ref04_75_Dmin.aiff', bpm: 75, pc: 2, mode: 'minor', style: 'boombap' },
  { file: 'ref05_160_Ebmaj.wav', bpm: 160, pc: 3, mode: 'major', style: 'trap' },
  { file: 'ref06_100_Gmin.mp3', bpm: 100, pc: 7, mode: 'minor', style: 'boombap' },
  { file: 'ref07_120_Emin.wav', bpm: 120, pc: 4, mode: 'minor', style: 'house' },
  { file: 'ref08_85_Bbmaj.flac', bpm: 85, pc: 10, mode: 'major', style: 'boombap' },
  { file: 'ref09_150_C#min.wav', bpm: 150, pc: 1, mode: 'minor', style: 'trap' },
  { file: 'ref10_110_Fmaj.aiff', bpm: 110, pc: 5, mode: 'major', style: 'house' },
];

const SR = 44100;
const SECONDS = 24;

function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 * 2 - 1; };
}

function synth(f: Fixture): Float32Array {
  const n = SR * SECONDS;
  const out = new Float32Array(n);
  const beat = 60 / f.bpm;
  const noise = rng(f.bpm * 31 + f.pc);
  const add = (t0: number, dur: number, fn: (t: number) => number, gain: number) => {
    const s0 = Math.floor(t0 * SR), s1 = Math.min(n, s0 + Math.floor(dur * SR));
    for (let i = s0; i < s1; i++) out[i] += gain * fn((i - s0) / SR);
  };
  const kick = (t: number) => Math.sin(2 * Math.PI * (50 * t + 60 * (1 - Math.exp(-t * 30)) / 30)) * Math.exp(-t * 9);
  const snare = (t: number) => (noise() * 0.8 + Math.sin(2 * Math.PI * 190 * t) * 0.4) * Math.exp(-t * 22);
  const hat = (t: number) => noise() * Math.exp(-t * 90);
  const freq = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
  const tone = (hz: number) => (t: number) =>
    (Math.sin(2 * Math.PI * hz * t) + 0.5 * Math.sin(4 * Math.PI * hz * t) + 0.25 * Math.sin(6 * Math.PI * hz * t)) *
    Math.min(1, t * 40) * Math.exp(-t * 0.6);

  // Progression centrée sur la tonique : I-IV-I-V (majeur) ou i-iv-i-v (mineur).
  const third = f.mode === 'major' ? 4 : 3;
  const degrees = [0, 5, 0, 7];
  const root = 48 + f.pc; // octave de la basse : C3 + pc
  const bars = Math.floor(SECONDS / (beat * 4));
  for (let bar = 0; bar < bars; bar++) {
    const t0 = bar * beat * 4;
    const deg = degrees[bar % 4];
    const chordRoot = root + 12 + deg;
    // Accord tenu sur la mesure (fondamentale, tierce mineure/majeure selon le degré, quinte).
    const chordThird = deg === 0 ? third : deg === 5 ? third : 4; // le V est majeur (sensible)
    for (const iv of [0, chordThird, 7]) add(t0, beat * 4, tone(freq(chordRoot + iv)), 0.09);
    add(t0, beat * 2, tone(freq(root + deg - 12)), 0.22);
    add(t0 + beat * 2, beat * 2, tone(freq(root + deg - 12)), 0.18);
    for (let b = 0; b < 4; b++) {
      const tb = t0 + b * beat;
      if (f.style === 'house' || b % 2 === 0) add(tb, 0.35, kick, 0.9);
      if (f.style === 'trap' && b === 3) add(tb + beat * 0.5, 0.3, kick, 0.7);
      if (b % 2 === 1) add(f.style === 'trap' ? tb : tb, 0.2, snare, f.style === 'trap' ? 0.25 : 0.5);
      const hatsPerBeat = f.style === 'trap' ? 4 : 2;
      for (let h = 0; h < hatsPerBeat; h++) add(tb + (h * beat) / hatsPerBeat, 0.05, hat, 0.12);
    }
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < n; i++) out[i] = (out[i] / peak) * 0.9;
  return out;
}

function wav16Stereo(x: Float32Array): Buffer {
  const data = Buffer.alloc(x.length * 4);
  for (let i = 0; i < x.length; i++) {
    const v = Math.max(-1, Math.min(1, x[i])) * 32767;
    data.writeInt16LE(v | 0, i * 4);
    data.writeInt16LE(v | 0, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

export async function makeFixtures(dir = path.resolve(import.meta.dirname, '../tests/fixtures/generated')) {
  await mkdir(dir, { recursive: true });
  for (const f of FIXTURES) {
    const target = path.join(dir, f.file);
    const wav = target.replace(/\.\w+$/, '.src.wav');
    await writeFile(wav, wav16Stereo(synth(f)));
    if (f.file.endsWith('.wav')) await writeFile(target, await import('node:fs/promises').then((m) => m.readFile(wav)));
    else await convert(wav, target, f.file.endsWith('.mp3') ? ['-c:a', 'libmp3lame', '-b:a', '256k'] : []);
    await rm(wav);
  }
  return dir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`fixtures : ${await makeFixtures()}`);
}
