import { asService } from './db';
import { store } from './storage';

export const TRASH_DAYS = 30;
export const ABANDONED_HOURS = 24;

/**
 * Ménage périodique (lancé par le worker) :
 * - morceaux en corbeille depuis plus de 30 jours : supprimés, fichiers compris ;
 * - envois commencés mais jamais terminés depuis plus de 24 h : supprimés, fichiers compris.
 * Les lignes sont supprimées d'abord, puis les fichiers : au pire il reste un fichier orphelin, jamais une ligne sans fichier.
 */
export async function housekeeping(now = new Date()) {
  const keys: string[] = [];
  const counts = await asService(async (tx) => {
    const trashed = await tx<{ id: string; keys: (string | null)[] }[]>`
      delete from tracks t
      where t.deleted_at < ${now}::timestamptz - ${`${TRASH_DAYS} days`}::interval
      returning t.id, array(select unnest(array[v.original_key, v.preview_key]) from track_versions v where v.track_id = t.id) as keys`;
    // La sous-requête ci-dessus lit les versions avant leur suppression en cascade.
    for (const t of trashed) keys.push(...(t.keys.filter(Boolean) as string[]));

    const abandoned = await tx<{ trackId: string; originalKey: string }[]>`
      delete from track_versions
      where status = 'uploading' and created_at < ${now}::timestamptz - ${`${ABANDONED_HOURS} hours`}::interval
      returning track_id as "trackId", original_key as "originalKey"`;
    keys.push(...abandoned.map((a) => a.originalKey).filter((k) => k && k !== 'pending'));
    // Un morceau qui n'a plus aucune version (son seul envoi a été abandonné) disparaît aussi.
    const ids = [...new Set(abandoned.map((a) => a.trackId))];
    const emptied = ids.length ? await tx<{ id: string }[]>`
      delete from tracks t where t.id = any(${ids}::uuid[])
        and not exists (select 1 from track_versions v where v.track_id = t.id) returning id` : [];

    const imports = await tx<{ key: string }[]>`
      delete from imports where status = 'uploading' and created_at < ${now}::timestamptz - ${`${ABANDONED_HOURS} hours`}::interval
      returning original_key as key`;
    keys.push(...imports.map((i) => i.key).filter((k) => k && k !== 'pending'));

    return { trashedTracks: trashed.length, abandonedVersions: abandoned.length, emptiedTracks: emptied.length, abandonedImports: imports.length };
  });
  let filesRemoved = 0;
  for (const k of keys) {
    try { if (await store().exists(k)) { await store().remove([k]); filesRemoved++; } } catch { /* fichier orphelin : un prochain passage le retentera */ }
  }
  return { ...counts, filesRemoved };
}
