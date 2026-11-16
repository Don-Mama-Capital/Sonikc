import { spawn } from 'node:child_process';
import { ANALYSIS_SR } from '../audio/analyze';

function run(cmd: string, args: string[], opts: { collect?: boolean } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d: Buffer) => { if (opts.collect !== false) out.push(d); });
    p.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-4000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} a échoué (${code}) : ${err.trim().split('\n').pop()}`))));
  });
}

export type Probe = { format: string; durationMs: number; sampleRate: number; channels: number };

/** Lit les infos d'un fichier ; refuse ce qui n'est pas un fichier audio exploitable. */
export async function probe(file: string): Promise<Probe> {
  const raw = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(raw.toString());
  const audio = (info.streams ?? []).find((s: { codec_type: string }) => s.codec_type === 'audio');
  const video = (info.streams ?? []).find((s: { codec_type: string; disposition?: { attached_pic?: number } }) =>
    s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!audio || video) throw new Error('NOT_AUDIO');
  const duration = Number(info.format?.duration ?? audio.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('NOT_AUDIO');
  return {
    format: String(info.format?.format_name ?? 'unknown').split(',')[0],
    durationMs: Math.round(duration * 1000),
    sampleRate: Number(audio.sample_rate) || 0,
    channels: Number(audio.channels) || 0,
  };
}

/** Décode en mono 32 bits flottants à 22 050 Hz pour l'analyse. Limité à `maxSeconds`. */
export async function decodeMono(file: string, maxSeconds = 600): Promise<Float32Array> {
  const buf = await run('ffmpeg', ['-v', 'error', '-i', file, '-t', String(maxSeconds), '-vn', '-ac', '1', '-ar', String(ANALYSIS_SR), '-f', 'f32le', 'pipe:1']);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)).slice();
}

/** Aperçu d'écoute : MP3 192 kbit/s, lisible par tous les navigateurs. */
export async function transcodePreview(input: string, output: string) {
  await run('ffmpeg', ['-v', 'error', '-y', '-i', input, '-vn', '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '192k', output], { collect: false });
}

export async function convert(input: string, output: string, extra: string[] = []) {
  await run('ffmpeg', ['-v', 'error', '-y', '-i', input, ...extra, output], { collect: false });
}
