import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { unzip, type Unzipped } from 'fflate';
import { asService } from './db';
import { enqueue, type Job } from './jobs';
import { decodeMono, probe, transcodePreview } from './ffmpeg';
import { localPath, putFile, putStream } from './storage';
import { detectBpm, detectKey, waveformPeaks } from '../audio/analyze';
import { cleanTitle, isAudioFilename } from '../audio/title';
import { Readable } from 'node:stream';

export class PermanentError extends Error {}

async function sha256File(file: string) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Traite une version : vérifie que c'est de l'audio, empreinte, aperçu, forme d'onde, BPM, tonalité. */
export async function processVersion(versionId: string) {
  const [v] = await asService((tx) => tx<{ id: string; trackId: string; ownerId: string; key: string; status: string }[]>`
    select id, track_id as "trackId", owner_id as "ownerId", original_key as key, status from track_versions where id = ${versionId}`);
  if (!v) throw new PermanentError('version introuvable');
  if (v.status === 'ready') return;
  const original = localPath(v.key);
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'sonikc-proc-'));
  try {
    let info;
    try {
      info = await probe(original);
    } catch {
      throw new PermanentError('Ce fichier n’est pas un fichier audio lisible.');
    }
    const sha256 = await sha256File(original);
    const pcm = await decodeMono(original);
    const waveform = waveformPeaks(pcm);
    const bpm = detectBpm(pcm);
    const key = detectKey(pcm);
    const previewTmp = path.join(tmp, 'preview.mp3');
    await transcodePreview(original, previewTmp);
    const previewKey = v.key.replace(/original\.\w+$/, 'preview.mp3');
    await putFile(previewKey, previewTmp);

    await asService(async (tx) => {
      await tx`
        update track_versions set status = 'ready', error = null, sha256 = ${sha256}, format = ${info.format},
          duration_ms = ${info.durationMs}, sample_rate = ${info.sampleRate}, channels = ${info.channels},
          preview_key = ${previewKey}, waveform = ${tx.json(waveform)}, bpm_detected = ${bpm},
          key_detected_pc = ${key?.pc ?? null}, key_detected_mode = ${key?.mode ?? null}, processed_at = now()
        where id = ${versionId}`;
      // Les valeurs détectées ne remplacent jamais une valeur saisie par l'utilisateur.
      await tx`
        update tracks set
          bpm = case when bpm_source = 'user' then bpm else ${bpm} end,
          bpm_source = case when bpm_source = 'user' then 'user' when ${bpm}::numeric is null then 'none' else 'detected' end,
          key_pc = case when key_source = 'user' then key_pc else ${key?.pc ?? null}::smallint end,
          key_mode = case when key_source = 'user' then key_mode else ${key?.mode ?? null} end,
          key_source = case when key_source = 'user' then 'user' when ${key ? 'detected' : 'none'} = 'detected' then 'detected' else 'none' end,
          current_version_id = ${versionId}
        where id = ${v.trackId}`;
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function markVersionFailed(versionId: string, message: string) {
  await asService((tx) => tx`update track_versions set status = 'failed', error = ${message} where id = ${versionId}`);
}

const IGNORED = /(^|\/)(__MACOSX|\.)/;
export const MAX_ZIP_FILES = 200;
export const MAX_ZIP_UNPACKED = 600 * 1024 ** 2;

/** Déballe un ZIP : recrée l'arborescence en dossiers, un morceau par fichier audio. */
export async function processImport(importId: string) {
  const [im] = await asService((tx) => tx<{ ownerId: string; folderId: string | null; key: string; filename: string; status: string }[]>`
    select owner_id as "ownerId", folder_id as "folderId", original_key as key, original_filename as filename, status
    from imports where id = ${importId}`);
  if (!im) throw new PermanentError('import introuvable');
  if (im.status === 'done') return;
  const data = new Uint8Array(await readFile(localPath(im.key)));
  // Plafonds contre les archives piégées : taille décompressée totale et nombre de fichiers.
  let total = 0, count = 0, overflow = false;
  const files = await new Promise<Unzipped>((resolve, reject) =>
    unzip(data, {
      filter: (f) => {
        if (IGNORED.test(f.name) || !isAudioFilename(f.name)) return false;
        if (count + 1 > MAX_ZIP_FILES || total + f.originalSize > MAX_ZIP_UNPACKED) { overflow = true; return false; }
        count++; total += f.originalSize;
        return true;
      },
    }, (err, out) => (err ? reject(new PermanentError('Archive ZIP illisible.')) : resolve(out))));
  if (overflow) throw new PermanentError(`Archive trop volumineuse : ${MAX_ZIP_FILES} fichiers et ${MAX_ZIP_UNPACKED / 1024 ** 2} Mo décompressés au maximum.`);
  const names = Object.keys(files).filter((n) => !n.endsWith('/')).sort();
  let skipped = 0;
  await asService(async (tx) => {
    const [root] = await tx<{ id: string }[]>`
      insert into folders (owner_id, parent_id, name) values (${im.ownerId}, ${im.folderId}, ${cleanTitle(im.filename.replace(/\.zip$/i, '')) || 'Import'})
      returning id`;
    const folderCache = new Map<string, string>([['', root.id]]);
    const folderFor = async (dir: string): Promise<string> => {
      if (folderCache.has(dir)) return folderCache.get(dir)!;
      const parts = dir.split('/');
      const parent = await folderFor(parts.slice(0, -1).join('/'));
      const [f] = await tx<{ id: string }[]>`insert into folders (owner_id, parent_id, name) values (${im.ownerId}, ${parent}, ${parts.at(-1)!.slice(0, 120)}) returning id`;
      folderCache.set(dir, f.id);
      return f.id;
    };
    for (const name of names) {
      const bytes = files[name];
      if (!bytes.length) { skipped++; continue; }
      const dir = name.split('/').slice(0, -1).join('/');
      const folderId = await folderFor(dir);
      const ext = name.split('.').pop()!.toLowerCase().replace('wave', 'wav');
      const [t] = await tx<{ id: string }[]>`insert into tracks (owner_id, folder_id, title) values (${im.ownerId}, ${folderId}, ${cleanTitle(name)}) returning id`;
      const [v] = await tx<{ id: string }[]>`
        insert into track_versions (track_id, owner_id, version_no, label, original_filename, original_key, status, size_bytes)
        values (${t.id}, ${im.ownerId}, 1, 'v1', ${name.split('/').pop()!}, 'pending', 'processing', ${bytes.length}) returning id`;
      const key = `u/${im.ownerId}/t/${t.id}/v/${v.id}/original.${ext}`;
      await putStream(key, Readable.from(Buffer.from(bytes)), 500 * 1024 ** 2);
      await tx`update track_versions set original_key = ${key} where id = ${v.id}`;
      await tx`update tracks set current_version_id = ${v.id} where id = ${t.id}`;
      await enqueue(tx, 'process_version', { versionId: v.id });
    }
    await tx`update imports set status = 'done', created_folder_id = ${root.id}, tracks_created = ${names.length - skipped}, files_skipped = ${skipped} where id = ${importId}`;
  });
}

export async function markImportFailed(importId: string, message: string) {
  await asService((tx) => tx`update imports set status = 'failed', error = ${message} where id = ${importId}`);
}

/** Exécute une tâche. Les erreurs « permanentes » ne sont pas retentées. */
export async function runJob(job: Job) {
  if (job.kind === 'process_version') return processVersion(job.payload.versionId);
  if (job.kind === 'unzip_import') return processImport(job.payload.importId);
  throw new PermanentError(`type de tâche inconnu : ${job.kind}`);
}

export async function onJobGiveUp(job: Job, message: string) {
  if (job.kind === 'process_version') await markVersionFailed(job.payload.versionId, message);
  if (job.kind === 'unzip_import') await markImportFailed(job.payload.importId, message);
}
