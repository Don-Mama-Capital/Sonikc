import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { asService } from '@/lib/server/db';
import { housekeeping } from '@/lib/server/housekeeping';
import { browse, listTrash, trashTrack } from '@/lib/server/library';
import { completeUpload, startUpload } from '@/lib/server/uploads';
import { exists, putStream } from '@/lib/server/storage';
import { drain } from '../../worker/index';
import { makeUser } from './helpers';

const fixture = path.resolve(import.meta.dirname, '../fixtures/generated/ref02_90_Cmaj.mp3');

async function uploaded(userId: string) {
  const buf = await readFile(fixture);
  const t = await startUpload(userId, { filename: 'beat.mp3', size: buf.length });
  const key = new URL(t.uploadUrl, 'http://x').searchParams.get('key')!;
  await putStream(key, Readable.from(buf), buf.length);
  await completeUpload(userId, t.kind, t.id);
  await drain();
  const [v] = await asService((tx) => tx<{ original: string; preview: string }[]>`select original_key as original, preview_key as preview from track_versions where id = ${t.id}`);
  return { trackId: t.trackId!, versionId: t.id, ...v };
}

describe('Ménage automatique', () => {
  it('corbeille : supprimé après 30 jours avec ses fichiers, pas avant', async () => {
    const u = await makeUser();
    const old = await uploaded(u.id);
    const recent = await uploaded(u.id);
    await trashTrack(u.id, old.trackId);
    await trashTrack(u.id, recent.trackId);
    await asService((tx) => tx`update tracks set deleted_at = now() - interval '31 days' where id = ${old.trackId}`);
    await asService((tx) => tx`update tracks set deleted_at = now() - interval '29 days' where id = ${recent.trackId}`);
    const r = await housekeeping();
    expect(r.trashedTracks).toBeGreaterThanOrEqual(1);
    expect(await exists(old.original)).toBe(false);
    expect(await exists(old.preview)).toBe(false);
    expect(await exists(recent.original)).toBe(true);
    expect((await listTrash(u.id)).map((t) => t.id)).toEqual([recent.trackId]);
  });

  it('envoi abandonné depuis plus de 24 h : supprimé ; un envoi récent ou terminé est gardé', async () => {
    const u = await makeUser();
    const done = await uploaded(u.id);
    const stale = await startUpload(u.id, { filename: 'jamais-fini.wav', size: 10 });
    const fresh = await startUpload(u.id, { filename: 'en-cours.wav', size: 10 });
    const staleKey = new URL(stale.uploadUrl, 'http://x').searchParams.get('key')!;
    await putStream(staleKey, Readable.from(Buffer.from('moitié')), 100); // fichier partiel, jamais confirmé
    await asService((tx) => tx`update track_versions set created_at = now() - interval '25 hours' where id = ${stale.id}`);
    // Un vieux morceau terminé n'est pas concerné, même ancien.
    await asService((tx) => tx`update track_versions set created_at = now() - interval '40 days' where id = ${done.versionId}`);
    await housekeeping();
    const titles = (await browse(u.id, {})).tracks.map((t) => t.title).sort();
    expect(titles).toEqual(['beat', 'en-cours']);
    expect(await exists(staleKey)).toBe(false);
    expect(await exists(done.original)).toBe(true);
    const [still] = await asService((tx) => tx`select 1 from track_versions where id = ${fresh.id}`);
    expect(still).toBeTruthy();
  });

  it('nouvelle version abandonnée : le morceau et sa version prête sont gardés', async () => {
    const u = await makeUser();
    const t = await uploaded(u.id);
    const v2 = await startUpload(u.id, { filename: 'v2.wav', size: 10, trackId: t.trackId });
    await asService((tx) => tx`update track_versions set created_at = now() - interval '2 days' where id = ${v2.id}`);
    await housekeeping();
    const [{ n }] = await asService((tx) => tx<{ n: number }[]>`select count(*)::int as n from track_versions where track_id = ${t.trackId}`);
    expect(n).toBe(1);
    expect((await browse(u.id, {})).tracks).toHaveLength(1);
  });
});
