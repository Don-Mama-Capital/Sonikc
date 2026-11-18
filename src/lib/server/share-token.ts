import { hmac, safeEqualStr } from './crypto';

/**
 * Jeton d'un lien de partage = identifiant du lien + signature du serveur (44 caractères).
 * Rien de secret n'est stocké : le propriétaire peut recopier son lien à tout moment, et un jeton
 * inventé ou modifié est rejeté avant toute requête en base.
 */
const idToB64 = (id: string) => Buffer.from(id.replace(/-/g, ''), 'hex').toString('base64url');
const b64ToId = (s: string) => {
  const h = Buffer.from(s, 'base64url').toString('hex');
  return h.length === 32 ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : null;
};
const mac = (id: string) => hmac(`share:${id}`).slice(0, 22);

export const linkToken = (linkId: string) => `${idToB64(linkId)}${mac(linkId)}`;

export function parseLinkToken(token: string): string | null {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{44}$/.test(token)) return null;
  const id = b64ToId(token.slice(0, 22));
  if (!id || !safeEqualStr(token.slice(22), mac(id))) return null;
  return id;
}

/** Adresse audio d'un morceau partagé : liée au lien, signée, à durée limitée. */
export function sharedAudioPath(token: string, linkId: string, versionId: string, ttlS = 2 * 3600, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttlS;
  return `/api/s/${token}/audio/${versionId}?exp=${exp}&sig=${hmac(`saudio:${linkId}:${versionId}:${exp}`)}`;
}

export function verifySharedAudio(linkId: string, versionId: string, exp: string | null, sig: string | null, now = Date.now()) {
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) * 1000 < now) return false;
  return safeEqualStr(sig, hmac(`saudio:${linkId}:${versionId}:${exp}`));
}
