import { hmac, safeEqualStr } from './crypto';

/** Jeton des liens d'un email (ouverture, clic, désinscription) : identifiant de l'envoi signé, rien de stocké. */
const enc = (id: string) => Buffer.from(id.replace(/-/g, ''), 'hex').toString('base64url');
const mac = (id: string) => hmac(`email:${id}`).slice(0, 22);

export const sendToken = (sendId: string) => `${enc(sendId)}${mac(sendId)}`;

export function parseSendToken(token: string): string | null {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{44}$/.test(token)) return null;
  const h = Buffer.from(token.slice(0, 22), 'base64url').toString('hex');
  if (h.length !== 32) return null;
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return safeEqualStr(token.slice(22), mac(id)) ? id : null;
}
