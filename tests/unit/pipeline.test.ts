import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { zipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { startUpload, completeUpload } from '@/lib/server/uploads';
import { putStream, exists, verifyUploadToken } from '@/lib/server/storage';
import { browse, getTrack, renameVersion, setCurrentVersion, updateTrack } from '@/lib/server/library';
import { asService } from '@/lib/server/db';
import { drain } from '../../worker/index';
import { FIXTURES, makeFixtures } from '../../scripts/make-fixtures';
import { makeUser } from './helpers';

const dir = path.resolve(import.meta.dirname, '../fixtures/generated');
beforeAll(async () => {
  if (!FIXTURES.every((f) => existsSync(path.join(dir, f.file)))) await makeFixtures(dir);
}, 180_000);

/** Simule le navigateur : demande un ticket, envoie le fichier, confirme. */
async function upload(userId: string, file: string, extra: Record<string, string> = {}, as?: string) {
  const buf = await readFile(file);
  const t = await startUpload(userId, { filename: as ?? path.basename(file), size: buf.length, ...extra });
  const q = new URL(t.uploadUrl, 'http://x').searchParams;
  expect(verifyUploadToken(q.get('key')!, Number(q.get('exp')), Number(q.get('max')), q.get('sig')!)).toBe(true);
  await putStream(q.get('key')!, Readable.from(buf), Number(q.get('max')));
  await completeUpload(userId, t.kind, t.id);
  return t;
}

describe('Envoi et traitement d’un morceau', () => {
  it.each(FIXTURES.slice(0, 4))('$file : accepté, empreinte, aperçu, forme d’onde, BPM et tonalité', async (f) => {
    const u = await makeUser();
    const file = path.join(dir, f.file);
    const t = await upload(u.id, file);
    await drain();
    const { track, versions } = await getTrack(u.id, t.trackId!);
    expect(versions[0].status).toBe('ready');
    expect(versions[0].sha256).toBe(createHash('sha256').update(await readFile(file)).digest('hex'));
    expect(track.title).toBe(f.file.replace(/\.\w+$/, '').replace(/_/g, ' '));
    expect(track.title).not.toMatch(/\.(wav|mp3|flac|aiff)$/);
    expect(track.bpm).toBe(f.bpm);
    expect([track.keyPc, track.keyMode]).toEqual([f.pc, f.mode]);
    expect(track.bpmSource).toBe('detected');
    expect(track.version?.waveform).toHaveLength(800);
    expect(track.version?.previewUrl).toMatch(/^\/api\/files\/u\/.+preview\.mp3\?exp=\d+&sig=/);
  });

  it('BPM et tonalité restent modifiables, et une nouvelle version ne les écrase pas', async () => {
    const u = await makeUser();
    const t = await upload(u.id, path.join(dir, FIXTURES[0].file));
    await drain();
    await updateTrack(u.id, t.trackId!, { bpm: 70, key: 'C maj', tags: ['Dark', 'trap', 'dark'] });
    await upload(u.id, path.join(dir, FIXTURES[1].file), { trackId: t.trackId! });
    await drain();
    const { track, versions } = await getTrack(u.id, t.trackId!);
    expect(versions.map((v) => v.label)).toEqual(['v2', 'v1']);
    expect(track.version?.label).toBe('v2');
    expect(track.bpm).toBe(70);
    expect([track.keyPc, track.keyMode, track.keySource]).toEqual([0, 'major', 'user']);
    expect(track.tags).toEqual(['dark', 'trap']);
  });

  it('v1, v2 et master restent sous un seul morceau ; on choisit la version écoutée', async () => {
    const u = await makeUser();
    const t = await upload(u.id, path.join(dir, FIXTURES[2].file));
    await drain();
    await upload(u.id, path.join(dir, FIXTURES[3].file), { trackId: t.trackId! });
    const t3 = await upload(u.id, path.join(dir, FIXTURES[6].file), { trackId: t.trackId! });
    await drain();
    await renameVersion(u.id, t3.id, 'master');
    let { versions, track } = await getTrack(u.id, t.trackId!);
    expect(versions.map((v) => v.label)).toEqual(['master', 'v2', 'v1']);
    expect(track.version?.label).toBe('master');
    await setCurrentVersion(u.id, t.trackId!, versions[2].id);
    ({ track } = await getTrack(u.id, t.trackId!));
    expect(track.version?.label).toBe('v1');
    const lib = await browse(u.id, {});
    expect(lib.tracks).toHaveLength(1);
    expect(lib.tracks[0].versionCount).toBe(3);
  });

  it('refuse un fichier qui n’est pas de l’audio, avec un message clair', async () => {
    const u = await makeUser();
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'sk-'));
    const fake = path.join(tmp, 'pas-un-son.wav');
    await writeFile(fake, 'ceci est du texte');
    const t = await upload(u.id, fake);
    await drain();
    const { versions } = await getTrack(u.id, t.trackId!);
    expect(versions[0].status).toBe('failed');
    expect(versions[0].error).toMatch(/pas un fichier audio/);
  });

  it('refuse les formats non pris en charge et les fichiers trop lourds', async () => {
    const u = await makeUser();
    await expect(startUpload(u.id, { filename: 'beat.exe', size: 10 })).rejects.toThrow(/Formats acceptés/);
    await expect(startUpload(u.id, { filename: 'beat.wav', size: 600 * 1024 ** 2 })).rejects.toThrow(/trop lourd/);
  });

  it('un ZIP de stems est déballé et rangé en dossiers', async () => {
    const u = await makeUser();
    const a = new Uint8Array(await readFile(path.join(dir, FIXTURES[1].file)));
    const b = new Uint8Array(await readFile(path.join(dir, FIXTURES[5].file)));
    const zip = zipSync({
      'Pack Juin/Kick_Loop.mp3': a,
      'Pack Juin/Stems/Melodie.mp3': b,
      '__MACOSX/._Kick_Loop.mp3': new Uint8Array([1, 2, 3]),
      'Pack Juin/notes.txt': new TextEncoder().encode('ignoré'),
    });
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'sk-'));
    const zf = path.join(tmp, 'Pack_Juin.zip');
    await writeFile(zf, zip);
    await upload(u.id, zf);
    await drain();
    const root = await browse(u.id, {});
    expect(root.folders.map((f) => f.name)).toEqual(['Pack Juin']);
    const level1 = await browse(u.id, { folderId: root.folders[0].id });
    expect(level1.folders.map((f) => f.name)).toEqual(['Pack Juin']);
    const level2 = await browse(u.id, { folderId: level1.folders[0].id });
    expect(level2.tracks.map((t) => t.title)).toEqual(['Kick Loop']);
    expect(level2.folders.map((f) => f.name)).toEqual(['Stems']);
    const all = await browse(u.id, { q: 'melodie' });
    expect(all.tracks[0].version?.status).toBe('ready');
  });

  it('lot 5.1 : un ZIP n’importe pas au-delà de la limite de morceaux de l’offre, et le dit', async () => {
    const u = await makeUser(undefined, 'free');
    const { OFFERS } = await import('@/config/offers');
    const max = OFFERS.free.limits.tracks!;
    await asService((tx) => tx`insert into tracks (owner_id, title) select ${u.id}, 'b' || g from generate_series(1, ${max - 1}) g`);
    const a = new Uint8Array(await readFile(path.join(dir, FIXTURES[1].file)));
    const zip = zipSync({ 'A.mp3': a, 'B.mp3': a, 'C.mp3': a });
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'sk-'));
    const zf = path.join(tmp, 'Trois.zip');
    await writeFile(zf, zip);
    await upload(u.id, zf);
    await drain();
    const [im] = await asService((tx) => tx<{ created: number; skipped: number; error: string }[]>`
      select tracks_created as created, files_skipped as skipped, error from imports where owner_id = ${u.id}`);
    expect(im.created).toBe(1);
    expect(im.skipped).toBe(2);
    expect(im.error).toContain('2 fichiers non importés');
    expect(im.error).toContain(OFFERS.free.name);
  });

  it('le jeton d’envoi ne vaut que pour sa clé et expire', async () => {
    const u = await makeUser();
    const t = await startUpload(u.id, { filename: 'x.wav', size: 100 });
    const q = new URL(t.uploadUrl, 'http://x').searchParams;
    expect(verifyUploadToken(`${q.get('key')}x`, Number(q.get('exp')), Number(q.get('max')), q.get('sig')!)).toBe(false);
    expect(verifyUploadToken(q.get('key')!, Number(q.get('exp')), Number(q.get('max')) * 2, q.get('sig')!)).toBe(false);
    expect(verifyUploadToken(q.get('key')!, Math.floor(Date.now() / 1000) - 1, Number(q.get('max')), q.get('sig')!)).toBe(false);
  });

  it('confirmer un envoi sans fichier échoue proprement', async () => {
    const u = await makeUser();
    const t = await startUpload(u.id, { filename: 'x.wav', size: 100 });
    await expect(completeUpload(u.id, t.kind, t.id)).rejects.toThrow(/pas arrivé/);
    const other = await makeUser();
    await expect(completeUpload(other.id, t.kind, t.id)).rejects.toThrow(/introuvable/);
    const [row] = await asService((tx) => tx`select status from track_versions where id = ${t.id}`);
    expect(row.status).toBe('uploading');
    expect(await exists(new URL(t.uploadUrl, 'http://x').searchParams.get('key')!)).toBe(false);
  });
});
