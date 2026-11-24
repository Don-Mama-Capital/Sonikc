import { randomUUID } from 'node:crypto';
import { asService } from '@/lib/server/db';

/** Crée un utilisateur avec profil, directement en base (accès service). */
/**
 * Compte de test. Offre « studio » par défaut : les tests des phases 1 à 4 vérifient les fonctions sans les limites
 * des offres ; les tests des limites (lot 5.1) créent explicitement des comptes « free » ou « pro ».
 */
export async function makeUser(handle = `u_${randomUUID().slice(0, 8)}`, plan: 'free' | 'pro' | 'studio' = 'studio') {
  return asService(async (tx) => {
    const [u] = await tx<{ id: string }[]>`insert into users (email) values (${`${handle}@test.local`}) returning id`;
    await tx`insert into profiles (user_id, handle, display_name, plan) values (${u.id}, ${handle.toLowerCase()}, ${handle}, ${plan})`;
    return { id: u.id, handle: handle.toLowerCase(), email: `${handle}@test.local` };
  });
}
