import { z } from 'zod';
import { withUser, type Tx } from './db';
import { parseKey } from '../audio/keys';
import { signedUrl } from './storage';

/**
 * Opérations de la bibliothèque. Tout passe par withUser : la base filtre par propriétaire,
 * donc un identifiant d'un autre utilisateur se comporte comme un identifiant inexistant.
 */

export class NotFound extends Error { constructor(what = 'Élément introuvable.') { super(what); } }
export class Invalid extends Error {}

const uuid = z.string().uuid();
const name = z.string().trim().min(1).max(120);
const title = z.string().trim().min(1).max(160);
const tag = z.string().trim().toLowerCase().min(1).max(32).regex(/^[\p{L}\p{N} _.#&+-]+$/u);

export type TrackRow = {
  id: string; title: string; folderId: string | null; bpm: number | null; bpmSource: string;
  keyPc: number | null; keyMode: 'major' | 'minor' | null; keySource: string; tags: string[]; pinned: boolean;
  createdAt: string; updatedAt: string; deletedAt: string | null;
  version: { id: string; label: string; versionNo: number; status: string; error: string | null; durationMs: number | null; previewUrl: string | null; waveform: number[] | null } | null;
  versionCount: number;
};

const trackSelect = (tx: Tx) => tx`
  select t.id, t.title, t.folder_id as "folderId", t.bpm::float as bpm, t.bpm_source as "bpmSource",
         t.key_pc as "keyPc", t.key_mode as "keyMode", t.key_source as "keySource", t.tags, t.pinned,
         t.created_at as "createdAt", t.updated_at as "updatedAt", t.deleted_at as "deletedAt",
         v.id as "vId", v.label as "vLabel", v.version_no as "vNo", v.status as "vStatus", v.error as "vError",
         v.duration_ms as "vDuration", v.preview_key as "vPreview", v.waveform as "vWaveform",
         (select count(*)::int from track_versions x where x.track_id = t.id) as "versionCount"
  from tracks t left join track_versions v on v.id = t.current_version_id`;

type RawTrack = Record<string, unknown>;

function shapeTrack(r: RawTrack, withWaveform = true): TrackRow {
  return {
    id: r.id as string, title: r.title as string, folderId: r.folderId as string | null,
    bpm: r.bpm as number | null, bpmSource: r.bpmSource as string,
    keyPc: r.keyPc as number | null, keyMode: r.keyMode as TrackRow['keyMode'], keySource: r.keySource as string,
    tags: r.tags as string[], pinned: r.pinned as boolean,
    createdAt: (r.createdAt as Date).toISOString(), updatedAt: (r.updatedAt as Date).toISOString(),
    deletedAt: r.deletedAt ? (r.deletedAt as Date).toISOString() : null,
    version: r.vId ? {
      id: r.vId as string, label: r.vLabel as string, versionNo: r.vNo as number, status: r.vStatus as string,
      error: r.vError as string | null, durationMs: r.vDuration as number | null,
      previewUrl: r.vPreview && r.vStatus === 'ready' ? signedUrl(r.vPreview as string, 6 * 3600) : null,
      waveform: withWaveform ? (r.vWaveform as number[] | null) : null,
    } : null,
    versionCount: r.versionCount as number,
  };
}

export const searchSchema = z.object({
  folderId: uuid.nullish(),
  q: z.string().trim().max(100).optional(),
  bpmMin: z.coerce.number().min(20).max(300).optional(),
  bpmMax: z.coerce.number().min(20).max(300).optional(),
  key: z.string().max(20).optional(),
  tag: z.string().max(32).optional(),
});

/** Contenu d'un dossier (ou de la racine). Avec un critère de recherche, cherche dans toute la bibliothèque. */
export async function browse(userId: string, input: z.input<typeof searchSchema>) {
  const p = searchSchema.parse(input);
  const searching = Boolean(p.q || p.bpmMin || p.bpmMax || p.key || p.tag);
  const key = p.key ? parseKey(p.key) : null;
  if (p.key && !key) throw new Invalid('Tonalité non reconnue (exemples : Am, F# min, Eb maj).');
  return withUser(userId, async (tx) => {
    const folderId = p.folderId ?? null;
    if (folderId) {
      const [f] = await tx`select 1 from folders where id = ${folderId} and deleted_at is null`;
      if (!f) throw new NotFound('Dossier introuvable.');
    }
    const crumbs = folderId ? await tx<{ id: string; name: string }[]>`
      with recursive up as (
        select id, name, parent_id, 0 as depth from folders where id = ${folderId}
        union all
        select f.id, f.name, f.parent_id, up.depth + 1 from folders f join up on f.id = up.parent_id
      ) select id, name from up order by depth desc` : [];

    const like = p.q ? `%${p.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const tracks = await tx`
      ${trackSelect(tx)}
      where t.deleted_at is null
        ${searching ? tx`` : folderId ? tx`and t.folder_id = ${folderId}` : tx`and t.folder_id is null`}
        ${like ? tx`and (t.title ilike ${like} or exists (select 1 from unnest(t.tags) g where g ilike ${like}))` : tx``}
        ${p.bpmMin ? tx`and t.bpm >= ${p.bpmMin}` : tx``}
        ${p.bpmMax ? tx`and t.bpm <= ${p.bpmMax}` : tx``}
        ${key ? tx`and t.key_pc = ${key.pc} and t.key_mode = ${key.mode}` : tx``}
        ${p.tag ? tx`and ${p.tag.toLowerCase()} = any(t.tags)` : tx``}
      order by t.pinned desc, t.created_at desc
      limit 500`;

    const folders = searching ? [] : await tx<{ id: string; name: string; itemCount: number }[]>`
      select f.id, f.name,
        ((select count(*) from folders c where c.parent_id = f.id and c.deleted_at is null)
         + (select count(*) from tracks t where t.folder_id = f.id and t.deleted_at is null)
         + (select count(*) from projects p where p.folder_id = f.id and p.deleted_at is null))::int as "itemCount"
      from folders f
      where f.deleted_at is null and ${folderId ? tx`f.parent_id = ${folderId}` : tx`f.parent_id is null`}
      order by lower(f.name)`;

    const projects = await tx<{ id: string; title: string; pinned: boolean; trackCount: number }[]>`
      select p.id, p.title, p.pinned,
        (select count(*) from project_tracks pt join tracks t on t.id = pt.track_id
         where pt.project_id = p.id and t.deleted_at is null)::int as "trackCount"
      from projects p
      where p.deleted_at is null
        ${searching ? (like ? tx`and p.title ilike ${like}` : tx`and false`) : folderId ? tx`and p.folder_id = ${folderId}` : tx`and p.folder_id is null`}
      order by p.pinned desc, p.updated_at desc`;

    return { folderId, crumbs, folders, projects, tracks: tracks.map((r) => shapeTrack(r)), searching };
  });
}

export async function getTrack(userId: string, trackId: string) {
  uuid.parse(trackId);
  return withUser(userId, async (tx) => {
    const [row] = await tx`${trackSelect(tx)} where t.id = ${trackId}`;
    if (!row) throw new NotFound('Morceau introuvable.');
    const versions = await tx<{ id: string; label: string; versionNo: number; status: string; error: string | null; originalFilename: string; sha256: string | null; durationMs: number | null; format: string | null; sizeBytes: string | null; createdAt: Date; bpmDetected: number | null }[]>`
      select id, label, version_no as "versionNo", status, error, original_filename as "originalFilename", sha256,
             duration_ms as "durationMs", format, size_bytes as "sizeBytes", created_at as "createdAt", bpm_detected::float as "bpmDetected"
      from track_versions where track_id = ${trackId} order by version_no desc`;
    const projects = await tx<{ id: string; title: string }[]>`
      select p.id, p.title from project_tracks pt join projects p on p.id = pt.project_id
      where pt.track_id = ${trackId} and p.deleted_at is null order by p.title`;
    return { track: shapeTrack(row), versions: versions.map((v) => ({ ...v, sizeBytes: v.sizeBytes ? Number(v.sizeBytes) : null, createdAt: v.createdAt.toISOString() })), projects };
  });
}

export const trackPatchSchema = z.object({
  title: title.optional(),
  bpm: z.number().min(20).max(300).nullable().optional(),
  key: z.string().max(20).nullable().optional(),
  tags: z.array(tag).max(20).optional(),
  pinned: z.boolean().optional(),
  folderId: uuid.nullable().optional(),
});

export async function updateTrack(userId: string, trackId: string, patch: z.input<typeof trackPatchSchema>) {
  uuid.parse(trackId);
  const p = trackPatchSchema.parse(patch);
  let key: { pc: number; mode: 'major' | 'minor' } | null | undefined;
  if (p.key !== undefined) {
    key = p.key === null || p.key.trim() === '' ? null : parseKey(p.key);
    if (key === null && p.key && p.key.trim() !== '') throw new Invalid('Tonalité non reconnue (exemples : Am, F# min, Eb maj).');
  }
  return withUser(userId, async (tx) => {
    if (p.folderId) {
      const [f] = await tx`select 1 from folders where id = ${p.folderId} and deleted_at is null`;
      if (!f) throw new NotFound('Dossier introuvable.');
    }
    const rows = await tx`
      update tracks set
        title = coalesce(${p.title ?? null}, title),
        bpm = case when ${p.bpm !== undefined} then ${p.bpm ?? null}::numeric else bpm end,
        bpm_source = case when ${p.bpm !== undefined} then (case when ${p.bpm ?? null}::numeric is null then 'none' else 'user' end) else bpm_source end,
        key_pc = case when ${key !== undefined} then ${key?.pc ?? null}::smallint else key_pc end,
        key_mode = case when ${key !== undefined} then ${key?.mode ?? null} else key_mode end,
        key_source = case when ${key !== undefined} then ${key ? 'user' : 'none'} else key_source end,
        tags = coalesce(${p.tags ? Array.from(new Set(p.tags)) : null}::text[], tags),
        pinned = coalesce(${p.pinned ?? null}, pinned),
        folder_id = case when ${p.folderId !== undefined} then ${p.folderId ?? null}::uuid else folder_id end
      where id = ${trackId} and deleted_at is null
      returning id`;
    if (!rows.length) throw new NotFound('Morceau introuvable.');
  });
}

/** Mise à la corbeille (récupérable). */
export async function trashTrack(userId: string, trackId: string) {
  uuid.parse(trackId);
  await withUser(userId, async (tx) => {
    const r = await tx`update tracks set deleted_at = now(), pinned = false where id = ${trackId} and deleted_at is null returning id`;
    if (!r.length) throw new NotFound('Morceau introuvable.');
  });
}

export async function restoreTrack(userId: string, trackId: string) {
  uuid.parse(trackId);
  await withUser(userId, async (tx) => {
    // Lot 5.1 : un morceau restauré compte dans la limite de morceaux de l'offre.
    const { limitsFor, fail } = await import('./plans');
    const { plan, limits } = await limitsFor(tx, userId);
    if (limits.tracks !== null) {
      const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from tracks where deleted_at is null`;
      if (n >= limits.tracks) fail(plan, 'tracks', n + 1);
    }
    // Si son dossier a disparu entre-temps, le morceau revient à la racine.
    const r = await tx`
      update tracks t set deleted_at = null,
        folder_id = case when exists (select 1 from folders f where f.id = t.folder_id and f.deleted_at is null) then t.folder_id else null end
      where t.id = ${trackId} and t.deleted_at is not null returning id`;
    if (!r.length) throw new NotFound('Morceau introuvable dans la corbeille.');
  });
}

export async function listTrash(userId: string) {
  return withUser(userId, async (tx) => {
    const rows = await tx`${trackSelect(tx)} where t.deleted_at is not null order by t.deleted_at desc limit 500`;
    return rows.map((r) => shapeTrack(r, false));
  });
}

// ───────── Versions ─────────

export async function setCurrentVersion(userId: string, trackId: string, versionId: string) {
  uuid.parse(trackId); uuid.parse(versionId);
  await withUser(userId, async (tx) => {
    const [v] = await tx<{ status: string }[]>`select status from track_versions where id = ${versionId} and track_id = ${trackId}`;
    if (!v) throw new NotFound('Version introuvable.');
    if (v.status !== 'ready') throw new Invalid('Cette version n’est pas encore prête.');
    await tx`update tracks set current_version_id = ${versionId} where id = ${trackId}`;
  });
}

export async function renameVersion(userId: string, versionId: string, label: string) {
  uuid.parse(versionId);
  const l = z.string().trim().min(1).max(40).parse(label);
  await withUser(userId, async (tx) => {
    const r = await tx`update track_versions set label = ${l} where id = ${versionId} returning id`;
    if (!r.length) throw new NotFound('Version introuvable.');
  });
}

// ───────── Dossiers ─────────

export async function createFolder(userId: string, input: { name: string; parentId?: string | null }) {
  const n = name.parse(input.name);
  const parentId = input.parentId ? uuid.parse(input.parentId) : null;
  return withUser(userId, async (tx) => {
    if (parentId) {
      const [f] = await tx`select 1 from folders where id = ${parentId} and deleted_at is null`;
      if (!f) throw new NotFound('Dossier parent introuvable.');
    }
    const [row] = await tx<{ id: string }[]>`insert into folders (owner_id, parent_id, name) values (${userId}, ${parentId}, ${n}) returning id`;
    return row;
  });
}

export async function updateFolder(userId: string, folderId: string, input: { name?: string; parentId?: string | null }) {
  uuid.parse(folderId);
  const n = input.name !== undefined ? name.parse(input.name) : undefined;
  const parentId = input.parentId === undefined ? undefined : input.parentId ? uuid.parse(input.parentId) : null;
  if (parentId === folderId) throw new Invalid('Un dossier ne peut pas se contenir lui-même.');
  try {
    await withUser(userId, async (tx) => {
      if (parentId) {
        const [f] = await tx`select 1 from folders where id = ${parentId} and deleted_at is null`;
        if (!f) throw new NotFound('Dossier de destination introuvable.');
      }
      const r = await tx`
        update folders set
          name = coalesce(${n ?? null}, name),
          parent_id = case when ${parentId !== undefined} then ${parentId ?? null}::uuid else parent_id end
        where id = ${folderId} and deleted_at is null returning id`;
      if (!r.length) throw new NotFound('Dossier introuvable.');
    });
  } catch (e) {
    if (String((e as Error).message).includes('folder cycle')) throw new Invalid('Impossible de ranger un dossier dans un de ses sous-dossiers.');
    throw e;
  }
}

/**
 * Supprime un dossier sans rien perdre : son contenu (sous-dossiers, morceaux, projets)
 * remonte dans le dossier parent, puis le dossier vide disparaît.
 */
export async function deleteFolder(userId: string, folderId: string) {
  uuid.parse(folderId);
  return withUser(userId, async (tx) => {
    const [f] = await tx<{ parentId: string | null }[]>`select parent_id as "parentId" from folders where id = ${folderId} and deleted_at is null for update`;
    if (!f) throw new NotFound('Dossier introuvable.');
    const moved = await tx<{ n: number }[]>`
      with a as (update folders set parent_id = ${f.parentId} where parent_id = ${folderId} returning 1),
           b as (update tracks set folder_id = ${f.parentId} where folder_id = ${folderId} returning 1),
           c as (update projects set folder_id = ${f.parentId} where folder_id = ${folderId} returning 1)
      select ((select count(*) from a) + (select count(*) from b) + (select count(*) from c))::int as n`;
    await tx`delete from folders where id = ${folderId}`;
    return { movedItems: moved[0].n, movedTo: f.parentId };
  });
}

export async function listAllFolders(userId: string) {
  return withUser(userId, (tx) => tx<{ id: string; name: string; parentId: string | null }[]>`
    select id, name, parent_id as "parentId" from folders where deleted_at is null order by lower(name)`);
}

// ───────── Projets ─────────

export async function createProject(userId: string, input: { title: string; folderId?: string | null }) {
  const t = title.parse(input.title);
  const folderId = input.folderId ? uuid.parse(input.folderId) : null;
  return withUser(userId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`insert into projects (owner_id, folder_id, title) values (${userId}, ${folderId}, ${t}) returning id`;
    return row;
  });
}

export async function getProject(userId: string, projectId: string) {
  uuid.parse(projectId);
  return withUser(userId, async (tx) => {
    const [p] = await tx<{ id: string; title: string; folderId: string | null; pinned: boolean }[]>`
      select id, title, folder_id as "folderId", pinned from projects where id = ${projectId} and deleted_at is null`;
    if (!p) throw new NotFound('Projet introuvable.');
    const rows = await tx`
      ${trackSelect(tx)} join project_tracks pt on pt.track_id = t.id and pt.project_id = ${projectId}
      where t.deleted_at is null order by pt.position`;
    return { project: p, tracks: rows.map((r) => shapeTrack(r)) };
  });
}

export async function updateProject(userId: string, projectId: string, input: { title?: string; pinned?: boolean; folderId?: string | null }) {
  uuid.parse(projectId);
  const t = input.title !== undefined ? title.parse(input.title) : undefined;
  const folderId = input.folderId === undefined ? undefined : input.folderId ? uuid.parse(input.folderId) : null;
  await withUser(userId, async (tx) => {
    const r = await tx`
      update projects set title = coalesce(${t ?? null}, title), pinned = coalesce(${input.pinned ?? null}, pinned),
        folder_id = case when ${folderId !== undefined} then ${folderId ?? null}::uuid else folder_id end
      where id = ${projectId} and deleted_at is null returning id`;
    if (!r.length) throw new NotFound('Projet introuvable.');
  });
}

/** Supprimer un projet ne supprime aucun morceau : seule la liste disparaît (corbeille). */
export async function trashProject(userId: string, projectId: string) {
  uuid.parse(projectId);
  await withUser(userId, async (tx) => {
    const r = await tx`update projects set deleted_at = now(), pinned = false where id = ${projectId} and deleted_at is null returning id`;
    if (!r.length) throw new NotFound('Projet introuvable.');
  });
}

export async function addToProject(userId: string, projectId: string, trackIds: string[]) {
  uuid.parse(projectId);
  const ids = z.array(uuid).min(1).max(200).parse(trackIds);
  await withUser(userId, async (tx) => {
    const [p] = await tx`select 1 from projects where id = ${projectId} and deleted_at is null for update`;
    if (!p) throw new NotFound('Projet introuvable.');
    const [{ max }] = await tx<{ max: number }[]>`select coalesce(max(position), -1)::int as max from project_tracks where project_id = ${projectId}`;
    let pos = max;
    for (const id of ids) {
      const [t] = await tx`select 1 from tracks where id = ${id} and deleted_at is null`;
      if (!t) throw new NotFound('Morceau introuvable.');
      await tx`insert into project_tracks (project_id, track_id, owner_id, position) values (${projectId}, ${id}, ${userId}, ${++pos})
               on conflict do nothing`;
    }
  });
}

export async function removeFromProject(userId: string, projectId: string, trackId: string) {
  uuid.parse(projectId); uuid.parse(trackId);
  await withUser(userId, (tx) => tx`delete from project_tracks where project_id = ${projectId} and track_id = ${trackId}`);
}

export async function reorderProject(userId: string, projectId: string, trackIds: string[]) {
  uuid.parse(projectId);
  const ids = z.array(uuid).max(500).parse(trackIds);
  await withUser(userId, async (tx) => {
    const current = await tx<{ trackId: string }[]>`select track_id as "trackId" from project_tracks where project_id = ${projectId}`;
    const set = new Set(current.map((c) => c.trackId));
    if (ids.length !== set.size || !ids.every((i) => set.has(i))) throw new Invalid('La liste ne correspond pas au contenu du projet.');
    for (let i = 0; i < ids.length; i++) await tx`update project_tracks set position = ${i} where project_id = ${projectId} and track_id = ${ids[i]}`;
  });
}
