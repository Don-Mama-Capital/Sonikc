import { describe, expect, it } from 'vitest';
import { withUser, asService } from '@/lib/server/db';
import { makeUser } from './helpers';

describe('RLS : chaque utilisateur ne voit que son contenu', () => {
  it('un tiers ne lit, ne modifie ni ne supprime le morceau d’un autre', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const [track] = await withUser(alice.id, (tx) =>
      tx<{ id: string }[]>`insert into tracks (owner_id, title) values (${alice.id}, 'Secret') returning id`);

    const seen = await withUser(bob.id, (tx) => tx`select id from tracks where id = ${track.id}`);
    expect(seen).toHaveLength(0);

    const updated = await withUser(bob.id, (tx) => tx`update tracks set title = 'pwned' where id = ${track.id} returning id`);
    expect(updated).toHaveLength(0);

    const deleted = await withUser(bob.id, (tx) => tx`delete from tracks where id = ${track.id} returning id`);
    expect(deleted).toHaveLength(0);

    const [still] = await asService((tx) => tx<{ title: string }[]>`select title from tracks where id = ${track.id}`);
    expect(still.title).toBe('Secret');
  });

  it('un utilisateur ne peut pas créer de contenu au nom d’un autre', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    await expect(
      withUser(bob.id, (tx) => tx`insert into tracks (owner_id, title) values (${alice.id}, 'forged')`),
    ).rejects.toThrow(/row-level security/);
  });

  it('un utilisateur ne peut pas ranger son morceau dans le dossier d’un autre', async () => {
    const alice = await makeUser();
    const bob = await makeUser();
    const [folder] = await withUser(alice.id, (tx) =>
      tx<{ id: string }[]>`insert into folders (owner_id, name) values (${alice.id}, 'A') returning id`);
    await expect(
      withUser(bob.id, (tx) => tx`insert into tracks (owner_id, folder_id, title) values (${bob.id}, ${folder.id}, 'x')`),
    ).rejects.toThrow(/another user/);
  });

  it('le rôle applicatif n’a aucun accès aux sessions ni aux codes de connexion', async () => {
    const alice = await makeUser();
    await expect(withUser(alice.id, (tx) => tx`select * from sessions`)).rejects.toThrow(/permission denied/);
    await expect(withUser(alice.id, (tx) => tx`select * from login_codes`)).rejects.toThrow(/permission denied/);
    await expect(withUser(alice.id, (tx) => tx`select * from users`)).rejects.toThrow(/permission denied/);
  });

  it('un dossier ne peut pas devenir son propre descendant', async () => {
    const alice = await makeUser();
    await withUser(alice.id, async (tx) => {
      const [a] = await tx<{ id: string }[]>`insert into folders (owner_id, name) values (${alice.id}, 'A') returning id`;
      const [b] = await tx<{ id: string }[]>`insert into folders (owner_id, name, parent_id) values (${alice.id}, 'B', ${a.id}) returning id`;
      await expect(tx`update folders set parent_id = ${b.id} where id = ${a.id}`).rejects.toThrow(/cycle/);
    }).catch((e) => { if (!/cycle/.test(String(e))) throw e; });
  });
});
