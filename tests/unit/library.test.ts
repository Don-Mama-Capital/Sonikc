import { describe, expect, it } from 'vitest';
import { withUser } from '@/lib/server/db';
import {
  addToProject, browse, createFolder, createProject, deleteFolder, getProject, listTrash, removeFromProject,
  reorderProject, restoreTrack, trashProject, trashTrack, updateFolder, updateProject, updateTrack,
} from '@/lib/server/library';
import { makeUser } from './helpers';

async function track(userId: string, title: string, extra: { folderId?: string | null; bpm?: number; key?: [number, 'major' | 'minor']; tags?: string[] } = {}) {
  const [t] = await withUser(userId, (tx) => tx<{ id: string }[]>`
    insert into tracks (owner_id, folder_id, title, bpm, key_pc, key_mode, tags)
    values (${userId}, ${extra.folderId ?? null}, ${title}, ${extra.bpm ?? null}, ${extra.key?.[0] ?? null}, ${extra.key?.[1] ?? null}, ${extra.tags ?? []})
    returning id`);
  return t.id;
}

describe('Dossiers : déplacer, renommer, supprimer sans perte', () => {
  it('supprimer un dossier fait remonter tout son contenu dans le parent', async () => {
    const u = await makeUser();
    const parent = await createFolder(u.id, { name: 'Beats 2026' });
    const child = await createFolder(u.id, { name: 'Juin', parentId: parent.id });
    const sub = await createFolder(u.id, { name: 'Stems', parentId: child.id });
    const t1 = await track(u.id, 'Perdu', { folderId: child.id });
    const p1 = await createProject(u.id, { title: 'Pour Lyna', folderId: child.id });
    const r = await deleteFolder(u.id, child.id);
    expect(r.movedItems).toBe(3);
    const view = await browse(u.id, { folderId: parent.id });
    expect(view.folders.map((f) => f.id)).toEqual([sub.id]);
    expect(view.tracks.map((t) => t.id)).toEqual([t1]);
    expect(view.projects.map((p) => p.id)).toEqual([p1.id]);
  });

  it('renommer et déplacer un dossier garde son contenu ; pas de boucle possible', async () => {
    const u = await makeUser();
    const a = await createFolder(u.id, { name: 'A' });
    const b = await createFolder(u.id, { name: 'B', parentId: a.id });
    const t = await track(u.id, 'x', { folderId: b.id });
    await updateFolder(u.id, b.id, { name: 'B renommé', parentId: null });
    const root = await browse(u.id, {});
    expect(root.folders.map((f) => f.name).sort()).toEqual(['A', 'B renommé']);
    expect((await browse(u.id, { folderId: b.id })).tracks.map((x) => x.id)).toEqual([t]);
    await updateFolder(u.id, b.id, { parentId: a.id });
    await expect(updateFolder(u.id, a.id, { parentId: b.id })).rejects.toThrow(/sous-dossiers/);
    await expect(updateFolder(u.id, a.id, { parentId: a.id })).rejects.toThrow(/lui-même/);
  });

  it('fil d’Ariane du dossier courant', async () => {
    const u = await makeUser();
    const a = await createFolder(u.id, { name: 'A' });
    const b = await createFolder(u.id, { name: 'B', parentId: a.id });
    const c = await createFolder(u.id, { name: 'C', parentId: b.id });
    expect((await browse(u.id, { folderId: c.id })).crumbs.map((x) => x.name)).toEqual(['A', 'B', 'C']);
  });

  it('déplacer un morceau, puis le mettre à la corbeille et le restaurer', async () => {
    const u = await makeUser();
    const f = await createFolder(u.id, { name: 'F' });
    const t = await track(u.id, 'Mauvais rêve');
    await updateTrack(u.id, t, { folderId: f.id, title: 'Mauvais rêve (v2)' });
    expect((await browse(u.id, { folderId: f.id })).tracks[0].title).toBe('Mauvais rêve (v2)');
    await trashTrack(u.id, t);
    expect((await browse(u.id, { folderId: f.id })).tracks).toHaveLength(0);
    expect((await listTrash(u.id)).map((x) => x.id)).toEqual([t]);
    await deleteFolder(u.id, f.id);
    await restoreTrack(u.id, t);
    // Son dossier n'existe plus : il revient à la racine, rien n'est perdu.
    expect((await browse(u.id, {})).tracks.map((x) => x.id)).toEqual([t]);
  });

  it('un utilisateur ne voit ni ne touche les dossiers d’un autre', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const f = await createFolder(a.id, { name: 'Privé' });
    await expect(browse(b.id, { folderId: f.id })).rejects.toThrow(/introuvable/);
    await expect(deleteFolder(b.id, f.id)).rejects.toThrow(/introuvable/);
    await expect(updateFolder(b.id, f.id, { name: 'pwned' })).rejects.toThrow(/introuvable/);
  });
});

describe('Recherche', () => {
  it('par titre, BPM, tonalité et tag, dans toute la bibliothèque', async () => {
    const u = await makeUser();
    const f = await createFolder(u.id, { name: 'Profond' });
    const a = await track(u.id, 'Lueur Froide', { folderId: f.id, bpm: 170, key: [10, 'minor'], tags: ['drill', 'dark'] });
    const b = await track(u.id, 'Temps', { bpm: 155, key: [0, 'minor'], tags: ['trap'] });
    const c = await track(u.id, 'Soleil 100%', { bpm: 90, key: [0, 'major'], tags: ['boom bap'] });
    const ids = async (q: Record<string, unknown>) => (await browse(u.id, q)).tracks.map((t) => t.id).sort();
    expect(await ids({ q: 'lueur' })).toEqual([a]);
    expect(await ids({ q: 'DARK' })).toEqual([a]);
    expect(await ids({ q: '100%' })).toEqual([c]);
    expect(await ids({ q: '%' })).toEqual([c]);
    expect(await ids({ bpmMin: 150, bpmMax: 160 })).toEqual([b]);
    expect(await ids({ key: 'Cm' })).toEqual([b]);
    expect(await ids({ key: 'A# min' })).toEqual([a]);
    expect(await ids({ key: 'Bb min' })).toEqual([a]);
    expect(await ids({ tag: 'trap' })).toEqual([b]);
    expect(await ids({ key: 'C', bpmMax: 100 })).toEqual([c]);
    await expect(browse(u.id, { key: 'Z#' })).rejects.toThrow(/non reconnue/);
  });

  it('ne trouve jamais les morceaux d’un autre utilisateur', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await track(a.id, 'Unique-Zebra-Title');
    expect((await browse(b.id, { q: 'Zebra' })).tracks).toHaveLength(0);
  });

  it('les épinglés passent en premier', async () => {
    const u = await makeUser();
    const t1 = await track(u.id, 'Un');
    const t2 = await track(u.id, 'Deux');
    await updateTrack(u.id, t1, { pinned: true });
    expect((await browse(u.id, {})).tracks.map((t) => t.id)).toEqual([t1, t2]);
  });
});

describe('Projets', () => {
  it('ajouter, réordonner, retirer ; supprimer un projet ne supprime aucun morceau', async () => {
    const u = await makeUser();
    const p = await createProject(u.id, { title: 'Pour Lyna' });
    const [a, b, c] = [await track(u.id, 'A'), await track(u.id, 'B'), await track(u.id, 'C')];
    await addToProject(u.id, p.id, [a, b, c, a]);
    expect((await getProject(u.id, p.id)).tracks.map((t) => t.id)).toEqual([a, b, c]);
    await reorderProject(u.id, p.id, [c, a, b]);
    expect((await getProject(u.id, p.id)).tracks.map((t) => t.id)).toEqual([c, a, b]);
    await expect(reorderProject(u.id, p.id, [c, a])).rejects.toThrow(/ne correspond pas/);
    await removeFromProject(u.id, p.id, a);
    expect((await getProject(u.id, p.id)).tracks.map((t) => t.id)).toEqual([c, b]);
    await updateProject(u.id, p.id, { title: 'Pour Lyna (final)', pinned: true });
    await trashProject(u.id, p.id);
    expect((await browse(u.id, {})).tracks.map((t) => t.id).sort()).toEqual([a, b, c].sort());
    await expect(getProject(u.id, p.id)).rejects.toThrow(/introuvable/);
  });

  it('on ne peut pas mettre le morceau d’un autre dans son projet', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const p = await createProject(b.id, { title: 'P' });
    const t = await track(a.id, 'Pas à toi');
    await expect(addToProject(b.id, p.id, [t])).rejects.toThrow(/introuvable/);
  });
});
