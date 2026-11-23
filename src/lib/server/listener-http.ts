import { cookies } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { currentUser } from './session';
import { isProd } from './env';
import { resolveLink, unlockCookieName } from './viewer';
import { parseLinkToken } from './share-token';
import { CONSENT_COOKIE } from '@/config/cookies';

export const VISITOR_COOKIE = 'sk_vid';

/** Résout un lien de partage avec la session et le déverrouillage présents dans les cookies. */
export async function resolveFromCookies(token: string) {
  const jar = await cookies();
  const user = await currentUser();
  const linkId = parseLinkToken(token);
  const unlock = linkId ? jar.get(unlockCookieName(linkId))?.value : undefined;
  return { user, resolution: await resolveLink(token, user?.id ?? null, unlock) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Identifiant aléatoire du visiteur (aucune donnée personnelle) : sert à ne pas compter deux fois
 * la même écoute et à compter les auditeurs uniques.
 * Lot 5.3 : le cookie n'est posé qu'avec l'accord du visiteur. Sans accord, rien n'est écrit sur son appareil :
 * on utilise l'identifiant que la page garde en mémoire (`pageVisitor`, perdu au rechargement), et un cookie
 * posé avant un refus est effacé.
 */
export async function visitorId(create = true, pageVisitor?: unknown) {
  const jar = await cookies();
  const consent = jar.get(CONSENT_COOKIE)?.value;
  const v = jar.get(VISITOR_COOKIE)?.value;
  if (consent === 'accepted') {
    if (v && UUID.test(v)) return v;
    if (!create) return null;
    const id = randomUUID();
    jar.set(VISITOR_COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: isProd(), path: '/', maxAge: 365 * 24 * 3600 });
    return id;
  }
  if (v) jar.delete(VISITOR_COOKIE);
  if (typeof pageVisitor === 'string' && UUID.test(pageVisitor)) return pageVisitor;
  return create ? randomUUID() : null;
}
