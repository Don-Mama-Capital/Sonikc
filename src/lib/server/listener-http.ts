import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { currentUser } from './session';
import { isProd } from './env';
import { resolveLink, unlockCookieName } from './viewer';
import { parseLinkToken } from './share-token';

export const VISITOR_COOKIE = 'sk_vid';

/** Résout un lien de partage avec la session et le déverrouillage présents dans les cookies. */
export async function resolveFromCookies(token: string) {
  const jar = await cookies();
  const user = await currentUser();
  const linkId = parseLinkToken(token);
  const unlock = linkId ? jar.get(unlockCookieName(linkId))?.value : undefined;
  return { user, resolution: await resolveLink(token, user?.id ?? null, unlock) };
}

/**
 * Identifiant aléatoire du visiteur (aucune donnée personnelle) : sert à ne pas compter deux fois
 * la même écoute et à compter les auditeurs uniques. Créé à la première action, dans une route API.
 */
export async function visitorId(create = true) {
  const jar = await cookies();
  const v = jar.get(VISITOR_COOKIE)?.value;
  if (v && /^[0-9a-f-]{36}$/.test(v)) return v;
  if (!create) return null;
  const id = randomUUID();
  jar.set(VISITOR_COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: isProd(), path: '/', maxAge: 365 * 24 * 3600 });
  return id;
}
