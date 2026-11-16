import { randomUUID } from 'node:crypto';
import { asService } from '@/lib/server/db';

/** Crée un utilisateur avec profil, directement en base (accès service). */
export async function makeUser(handle = `u_${randomUUID().slice(0, 8)}`) {
  return asService(async (tx) => {
    const [u] = await tx<{ id: string }[]>`insert into users (email) values (${`${handle}@test.local`}) returning id`;
    await tx`insert into profiles (user_id, handle, display_name) values (${u.id}, ${handle.toLowerCase()}, ${handle})`;
    return { id: u.id, handle: handle.toLowerCase(), email: `${handle}@test.local` };
  });
}
