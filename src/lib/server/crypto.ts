import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from './env';

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

/** Empreinte d'un secret court (code de connexion), salée par l'email et poivrée par APP_SECRET. */
export const hashCode = (email: string, code: string) =>
  createHmac('sha256', env().APP_SECRET).update(`${email.toLowerCase()}:${code}`).digest('hex');

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export const randomCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export function safeEqualHex(a: string, b: string) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export const hmac = (data: string) => createHmac('sha256', env().APP_SECRET).update(data).digest('base64url');

export function safeEqualStr(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
