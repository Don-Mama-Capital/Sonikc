import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { asService, withUser } from '@/lib/server/db';
import { contactDetail, createContact, createGroup, deleteContact, importContacts, listContacts, listGroups, setGroupMembers, updateContact } from '@/lib/server/contacts';
import { contactsFromCsv } from '@/lib/server/csv';
import { createLink, updateShareSettings } from '@/lib/server/sharing';
import { parseLinkToken } from '@/lib/server/share-token';
import { interact, listenStart } from '@/lib/server/listening';
import { saveLink } from '@/lib/server/saves';
import { makeUser } from './helpers';

async function readyTrack(ownerId: string, durationMs = 100_000) {
  return asService(async (tx) => {
    const [t] = await tx<{ id: string }[]>`insert into tracks (owner_id, title, visibility, allow_download) values (${ownerId}, 'Beat', 'public', true) returning id`;
    const [v] = await tx<{ id: string }[]>`insert into track_versions (track_id, owner_id, version_no, label, status, original_filename, original_key, preview_key, duration_ms)
      values (${t.id}, ${ownerId}, 1, 'v1', 'ready', 'b.wav', ${`o/${t.id}`}, ${`p/${t.id}`}, ${durationMs}) returning id`;
    await tx`update tracks set current_version_id = ${v.id} where id = ${t.id}`;
    return t.id;
  });
}
/** Lien personnel (comme ceux de l'emailing) vers un morceau public. */
const personalLink = (ownerId: string, trackId: string, contactId: string) =>
  asService(async (tx) => (await tx<{ id: string }[]>`insert into share_links (owner_id, track_id, label, contact_id) values (${ownerId}, ${trackId}, 'Email', ${contactId}) returning id`)[0].id);
const setListened = (sessionId: string, ms: number) => asService((tx) => tx`update listen_sessions set listened_ms = ${ms} where id = ${sessionId}`);

describe('Lecture CSV', () => {
  it('séparateur « ; », guillemets, BOM, en-têtes français, tags multiples, sans en-tête', () => {
    const r = contactsFromCsv('﻿Nom;E-mail;Étiquettes\r\n"Dupont, Léa";LEA@Label.fr;"a&r|rap"\r\nSans mail;;x\r\n');
    expect(r.contacts).toEqual([{ line: 2, email: 'lea@label.fr', name: 'Dupont, Léa', tags: ['a&r', 'rap'] }]);
    expect(r.invalid).toEqual([{ line: 3, reason: 'adresse manquante' }]);
    const r2 = contactsFromCsv('bob@x.fr,Bob\nalice@y.com,Alice');
    expect(r2.contacts.map((c) => [c.email, c.name])).toEqual([['bob@x.fr', 'Bob'], ['alice@y.com', 'Alice']]);
  });
});

describe('Lot 3.1 — contacts', () => {
  it('1. import de 500 lignes : doublons fusionnés (fichier et existant), lignes invalides signalées', async () => {
    const u = await makeUser();
    for (let i = 0; i < 10; i++) await createContact(u.id, { email: `p${i}@test.fr`, tags: ['ancien'] });
    await updateContact(u.id, (await listContacts(u.id, { q: 'p3@test.fr' })).contacts[0].id, { name: 'Déjà nommé' });
    const lines = ['Nom;Email;Tags'];
    for (let i = 0; i < 447; i++) lines.push(`Personne ${i};p${i}@test.fr;rap`);
    for (let i = 0; i < 50; i++) lines.push(`;P${i}@TEST.FR;drill`); // doublons, autre casse
    lines.push('Cassé;pas-une-adresse;', 'Vide;;', 'Encore;@x;');
    const res = await importContacts(u.id, lines.join('\n'));
    expect(res).toMatchObject({ lines: 500, created: 437, merged: 60, invalidCount: 3 });
    expect(res.invalid.map((x) => x.line)).toEqual([499, 500, 501]);
    const all = await listContacts(u.id, { limit: 500 });
    expect(all.total).toBe(447);
    const p3 = all.contacts.find((c) => c.email === 'p3@test.fr')!;
    expect(p3.name).toBe('Déjà nommé');
    expect([...p3.tags].sort()).toEqual(['ancien', 'drill', 'rap']);
    const p100 = all.contacts.find((c) => c.email === 'p100@test.fr')!;
    expect(p100).toMatchObject({ name: 'Personne 100', tags: ['rap'] });
    // Réimporter le même fichier ne crée rien.
    expect((await importContacts(u.id, lines.join('\n'))).created).toBe(0);
  });

  it('2. un groupe à règle se met à jour seul après une écoute', async () => {
    const u = await makeUser();
    const trackId = await readyTrack(u.id);
    const { id: contactId } = await createContact(u.id, { email: `fan_${randomUUID().slice(0, 6)}@test.fr`, name: 'Fan' });
    const { id: groupId } = await createGroup(u.id, { name: 'Accrochés', rule: { type: 'listened_over', seconds: 60 } });
    expect((await listContacts(u.id, { groupId })).contacts).toEqual([]);
    const linkId = await personalLink(u.id, trackId, contactId);
    const { sessionId } = await listenStart({ userId: null, linkId, unlocked: false }, trackId, randomUUID());
    await setListened(sessionId!, 70_000);
    expect((await listContacts(u.id, { groupId })).contacts.map((c) => c.name)).toEqual(['Fan']);
    expect((await listGroups(u.id)).find((g) => g.id === groupId)).toMatchObject({ size: 1, description: 'A écouté plus de 60 s' });
  });

  it('3. score et dernière activité exacts ; un compte connecté avec la même adresse est reconnu', async () => {
    const u = await makeUser();
    const trackId = await readyTrack(u.id);
    const fanUser = await makeUser();
    const { id: contactId } = await createContact(u.id, { email: fanUser.email });
    const pub = await createLink(u.id, 'track', trackId, 'Public');
    const linkId = parseLinkToken(pub.url.split('/s/')[1])!;
    const ctx = { userId: fanUser.id, linkId, unlocked: false };
    const a = await listenStart(ctx, trackId, randomUUID()); await setListened(a.sessionId!, 40_000); // 1 point
    await asService((tx) => tx`update listen_sessions set last_beat_at = now() - interval '40 minutes' where id = ${a.sessionId}`);
    const b = await listenStart(ctx, trackId, randomUUID()); await setListened(b.sessionId!, 95_000); // complète : 3
    await interact(ctx, trackId, randomUUID(), 'download'); // 5
    await updateShareSettings(u.id, 'track', trackId, {});
    await saveLink(ctx); // 5
    // Activité anonyme sur le même lien : rattachée à personne.
    await listenStart({ userId: null, linkId, unlocked: false }, trackId, randomUUID());
    const [c] = (await listContacts(u.id, { q: fanUser.email })).contacts;
    expect(c).toMatchObject({ score: 14, plays: 2 });
    expect(Date.now() - new Date(c.lastActivityAt!).getTime()).toBeLessThan(60_000);
    const d = await contactDetail(u.id, contactId);
    expect(d.listens).toHaveLength(2);
    expect(d.events.map((e) => e.kind).sort()).toEqual(['download', 'save']);
    // Les points plus vieux que 90 jours ne comptent plus.
    await asService((tx) => tx`update listen_sessions set started_at = now() - interval '100 days' where contact_id = ${contactId}`);
    expect((await listContacts(u.id, { q: fanUser.email })).contacts[0].score).toBe(10);
  });

  it('4. chacun ne voit et ne modifie que ses contacts et groupes', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const { id } = await createContact(a.id, { email: 'secret@test.fr' });
    const { id: groupA } = await createGroup(a.id, { name: 'VIP' });
    expect((await listContacts(b.id)).total).toBe(0);
    expect(await withUser(b.id, (tx) => tx`select 1 from contacts where id = ${id}`)).toEqual([]);
    await expect(updateContact(b.id, id, { name: 'pirate' })).rejects.toThrow();
    await expect(deleteContact(b.id, id)).rejects.toThrow();
    await expect(contactDetail(b.id, id)).rejects.toThrow();
    await expect(setGroupMembers(b.id, groupA, [id], true)).rejects.toThrow();
    const { id: groupB } = await createGroup(b.id, { name: 'Le mien' });
    await setGroupMembers(b.id, groupB, [id], true); // contact d'un autre : ignoré
    expect((await listContacts(b.id, { groupId: groupB })).contacts).toEqual([]);
    await expect(asService((tx) => tx`insert into contact_group_members (group_id, contact_id, owner_id) values (${groupB}, ${id}, ${b.id})`)).rejects.toThrow('another user');
    await expect(asService((tx) => tx`insert into share_links (owner_id, project_id, label, contact_id) select ${b.id}, null, 'x', ${id}`)).rejects.toThrow();
  });

  it('groupes manuels, tags, recherche', async () => {
    const u = await makeUser();
    const { id: c1 } = await createContact(u.id, { email: 'a@label.fr', name: 'Alice', tags: ['A&R'] });
    await createContact(u.id, { email: 'b@studio.fr', name: 'Bob', tags: ['ingé'] });
    await expect(createContact(u.id, { email: 'A@label.fr' })).rejects.toThrow('existe déjà');
    const { id: g } = await createGroup(u.id, { name: 'Labels' });
    await setGroupMembers(u.id, g, [c1], true);
    expect((await listContacts(u.id, { groupId: g })).contacts.map((c) => c.name)).toEqual(['Alice']);
    expect((await listContacts(u.id, { tag: 'a&r' })).contacts.map((c) => c.name)).toEqual(['Alice']);
    expect((await listContacts(u.id, { q: 'studio' })).contacts.map((c) => c.name)).toEqual(['Bob']);
    expect((await listContacts(u.id, { q: '%' })).contacts).toEqual([]);
    const { id: tg } = await createGroup(u.id, { name: 'Ingés', rule: { type: 'tag', tag: 'ingé' } });
    expect((await listContacts(u.id, { groupId: tg })).contacts.map((c) => c.name)).toEqual(['Bob']);
    await expect(setGroupMembers(u.id, tg, [c1], true)).rejects.toThrow('règle');
    await expect(createGroup(u.id, { name: 'X', rule: { type: 'drop table' } })).rejects.toThrow();
  });
});
