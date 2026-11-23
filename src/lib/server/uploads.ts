import { z } from 'zod';
import { withUser } from './db';
import { NotFound, Invalid } from './library';
import { cleanTitle } from '../audio/title';
import { exists, size, store } from './storage';
import { GB, fail, limitsFor, storageUsed } from './plans';

export const AUDIO_EXTS = ['wav', 'wave', 'mp3', 'aif', 'aiff', 'flac'] as const;
export const MAX_AUDIO_BYTES = 500 * 1024 ** 2;
export const MAX_ZIP_BYTES = 300 * 1024 ** 2;

export const startSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  size: z.number().int().positive(),
  folderId: z.string().uuid().nullish(),
  projectId: z.string().uuid().nullish(),
  trackId: z.string().uuid().nullish(), // nouvelle version d'un morceau existant
});

export type UploadTicket = { kind: 'version' | 'import'; id: string; trackId?: string; uploadUrl: string; completeUrl: string };

function extOf(filename: string) {
  return (filename.split('.').pop() ?? '').toLowerCase();
}

/**
 * Prépare un envoi : crée les lignes en base et rend une URL d'envoi signée.
 * Le fichier ne passe jamais par une URL publique ; il est traité après `complete`.
 */
export async function startUpload(userId: string, input: z.input<typeof startSchema>): Promise<UploadTicket> {
  const p = startSchema.parse(input);
  const ext = extOf(p.filename);
  const isZip = ext === 'zip';
  if (!isZip && !(AUDIO_EXTS as readonly string[]).includes(ext)) {
    throw new Invalid('Formats acceptés : WAV, MP3, AIFF, FLAC, ou un ZIP qui en contient.');
  }
  const max = isZip ? MAX_ZIP_BYTES : MAX_AUDIO_BYTES;
  if (p.size > max) throw new Invalid(`Fichier trop lourd (max ${Math.round(max / 1024 ** 2)} Mo).`);

  return withUser(userId, async (tx) => {
    const { plan, limits } = await limitsFor(tx, userId);
    if ((await storageUsed(tx, userId)) + p.size > limits.storageGb * GB) fail(plan, 'storageGb');
    if (!isZip && !p.trackId && limits.tracks !== null) {
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from tracks where deleted_at is null`;
      if (n >= limits.tracks) fail(plan, 'tracks', n + 1);
    }
    if (p.folderId) {
      const [f] = await tx`select 1 from folders where id = ${p.folderId} and deleted_at is null`;
      if (!f) throw new NotFound('Dossier introuvable.');
    }
    if (isZip) {
      if (p.trackId) throw new Invalid('Une nouvelle version doit être un fichier audio, pas un ZIP.');
      const [row] = await tx<{ id: string }[]>`
        insert into imports (owner_id, folder_id, original_filename, original_key)
        values (${userId}, ${p.folderId ?? null}, ${p.filename}, 'pending') returning id`;
      const key = `u/${userId}/imports/${row.id}/source.zip`;
      await tx`update imports set original_key = ${key} where id = ${row.id}`;
      return await ticket('import', row.id, key, max);
    }

    let trackId = p.trackId ?? null;
    let versionNo = 1;
    if (trackId) {
      const [t] = await tx<{ n: number }[]>`
        select coalesce((select max(version_no) from track_versions where track_id = ${trackId}), 0)::int as n
        from tracks where id = ${trackId} and deleted_at is null`;
      if (!t) throw new NotFound('Morceau introuvable.');
      versionNo = t.n + 1;
    } else {
      const [t] = await tx<{ id: string }[]>`
        insert into tracks (owner_id, folder_id, title) values (${userId}, ${p.folderId ?? null}, ${cleanTitle(p.filename)}) returning id`;
      trackId = t.id;
    }
    const [v] = await tx<{ id: string }[]>`
      insert into track_versions (track_id, owner_id, version_no, label, original_filename, original_key)
      values (${trackId}, ${userId}, ${versionNo}, ${`v${versionNo}`}, ${p.filename}, 'pending') returning id`;
    const key = `u/${userId}/t/${trackId}/v/${v.id}/original.${ext === 'wave' ? 'wav' : ext}`;
    await tx`update track_versions set original_key = ${key} where id = ${v.id}`;
    if (versionNo === 1) await tx`update tracks set current_version_id = ${v.id} where id = ${trackId}`;
    if (p.projectId && versionNo === 1) {
      const [pr] = await tx`select 1 from projects where id = ${p.projectId} and deleted_at is null`;
      if (!pr) throw new NotFound('Projet introuvable.');
      await tx`insert into project_tracks (project_id, track_id, owner_id, position)
               values (${p.projectId}, ${trackId}, ${userId}, (select coalesce(max(position), -1) + 1 from project_tracks where project_id = ${p.projectId}))`;
    }
    return { ...(await ticket('version', v.id, key, max)), trackId };
  });
}

async function ticket(kind: 'version' | 'import', id: string, key: string, max: number): Promise<UploadTicket> {
  return { kind, id, uploadUrl: await store().uploadTarget(key, max), completeUrl: `/api/uploads/${kind}/${id}/complete` };
}

/** Le fichier est arrivé : on vérifie qu'il est là et on lance le traitement. */
export async function completeUpload(userId: string, kind: 'version' | 'import', id: string) {
  z.string().uuid().parse(id);
  return withUser(userId, async (tx) => {
    if (kind === 'version') {
      const [v] = await tx<{ key: string; status: string }[]>`select original_key as key, status from track_versions where id = ${id} for update`;
      if (!v) throw new NotFound('Envoi introuvable.');
      if (v.status !== 'uploading') return { status: v.status };
      if (!(await exists(v.key))) throw new Invalid('Le fichier n’est pas arrivé. Réessaie l’envoi.');
      await tx`update track_versions set status = 'processing', size_bytes = ${await size(v.key)} where id = ${id}`;
      await tx`select app.enqueue_job('process_version', ${id})`;
      return { status: 'processing' };
    }
    const [im] = await tx<{ key: string; status: string }[]>`select original_key as key, status from imports where id = ${id} for update`;
    if (!im) throw new NotFound('Envoi introuvable.');
    if (im.status !== 'uploading') return { status: im.status };
    if (!(await exists(im.key))) throw new Invalid('Le fichier n’est pas arrivé. Réessaie l’envoi.');
    await tx`update imports set status = 'processing' where id = ${id}`;
    await tx`select app.enqueue_job('unzip_import', ${id})`;
    return { status: 'processing' };
  });
}
