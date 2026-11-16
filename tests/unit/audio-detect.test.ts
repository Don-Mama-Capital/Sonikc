import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { detectBpm, detectKey, waveformPeaks } from '@/lib/audio/analyze';
import { decodeMono, probe } from '@/lib/server/ffmpeg';
import { formatKey } from '@/lib/audio/keys';
import { FIXTURES, makeFixtures } from '../../scripts/make-fixtures';

const dir = path.resolve(import.meta.dirname, '../fixtures/generated');

beforeAll(async () => {
  if (!FIXTURES.every((f) => existsSync(path.join(dir, f.file)))) await makeFixtures(dir);
}, 180_000);

describe('Détection sur les 10 fichiers de référence', () => {
  it.each(FIXTURES)('$file', async (f) => {
    const file = path.join(dir, f.file);
    const info = await probe(file);
    expect(info.durationMs).toBeGreaterThan(20_000);
    const pcm = await decodeMono(file);
    const bpm = detectBpm(pcm);
    const key = detectKey(pcm);
    const got = `${bpm} BPM, ${formatKey(key?.pc, key?.mode)}`;
    const want = `${f.bpm} BPM, ${formatKey(f.pc, f.mode)}`;
    expect(got).toBe(want);
  });

  it('forme d’onde : 800 valeurs entre 0 et 1, au moins une à 1', async () => {
    const pcm = await decodeMono(path.join(dir, FIXTURES[0].file));
    const peaks = waveformPeaks(pcm);
    expect(peaks).toHaveLength(800);
    expect(Math.max(...peaks)).toBe(1);
    expect(Math.min(...peaks)).toBeGreaterThanOrEqual(0);
  });
});
