import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { env } from './env';
import { hmac, safeEqualStr } from './crypto';

/**
 * Stockage privé des fichiers. Aucun fichier n'a d'adresse publique devinable :
 * l'accès passe par une URL signée qui expire (comme les URL signées de Supabase Storage).
 * Pilote local en développement ; le pilote Supabase arrivera avec la mise en ligne.
 */

const KEY_RE = /^[a-z0-9][a-z0-9/_.-]{0,300}$/i;

function root() {
  return path.resolve(env().STORAGE_DIR);
}

export function assertKey(key: string) {
  if (!KEY_RE.test(key) || key.includes('..') || key.includes('//')) throw new Error(`clé de stockage invalide : ${key}`);
}

export function localPath(key: string) {
  assertKey(key);
  const p = path.join(root(), key);
  if (!p.startsWith(root() + path.sep)) throw new Error('clé hors du stockage');
  return p;
}

export async function putStream(key: string, body: ReadableStream<Uint8Array> | Readable, maxBytes: number) {
  const dest = localPath(key);
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part-${process.pid}-${Date.now()}`;
  let total = 0;
  const source = body instanceof Readable ? body : Readable.fromWeb(body as never);
  const limiter = async function* (src: AsyncIterable<Buffer>) {
    for await (const chunk of src) {
      total += chunk.length;
      if (total > maxBytes) throw new Error('FILE_TOO_LARGE');
      yield chunk;
    }
  };
  try {
    await pipeline(source, limiter, createWriteStream(tmp));
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return { size: total };
}

export async function putFile(key: string, fromPath: string) {
  const dest = localPath(key);
  await mkdir(path.dirname(dest), { recursive: true });
  await pipeline(createReadStream(fromPath), createWriteStream(dest));
}

export async function exists(key: string) {
  return stat(localPath(key)).then((s) => s.isFile(), () => false);
}

export async function size(key: string) {
  return (await stat(localPath(key))).size;
}

export async function remove(key: string) {
  await rm(localPath(key), { force: true });
}

/** URL signée de lecture, valable `ttlSec` secondes. */
export function signedUrl(key: string, ttlSec = 3600, opts: { download?: string } = {}) {
  assertKey(key);
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const dl = opts.download ? encodeURIComponent(opts.download) : '';
  const sig = hmac(`get:${key}:${exp}:${dl}`);
  const q = new URLSearchParams({ exp: String(exp), sig });
  if (dl) q.set('dl', opts.download!);
  return `/api/files/${key}?${q}`;
}

export function verifySignedGet(key: string, exp: string | null, sig: string | null, dl: string | null) {
  if (!exp || !sig) return false;
  const n = Number(exp);
  if (!Number.isFinite(n) || n < Date.now() / 1000) return false;
  return safeEqualStr(sig, hmac(`get:${key}:${n}:${dl ? encodeURIComponent(dl) : ''}`));
}

/** Jeton d'envoi : autorise un seul PUT vers une clé précise, pendant `ttlSec`. */
export function uploadToken(key: string, maxBytes: number, ttlSec = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return { exp, max: maxBytes, sig: hmac(`put:${key}:${exp}:${maxBytes}`) };
}

export function verifyUploadToken(key: string, exp: number, max: number, sig: string) {
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  return safeEqualStr(sig, hmac(`put:${key}:${exp}:${max}`));
}
