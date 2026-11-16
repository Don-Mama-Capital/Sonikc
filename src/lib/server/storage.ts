import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { env } from './env';
import { hmac, safeEqualStr } from './crypto';

/**
 * Stockage privé des fichiers, derrière une interface unique :
 * - pilote « local » (développement, tests) : un dossier sur le disque ;
 * - pilote « supabase » (mise en ligne) : un bucket privé Supabase Storage.
 * Aucun fichier n'a d'adresse publique devinable : l'app signe ses propres URL qui expirent,
 * et la route /api/files sert le fichier (local) ou redirige vers une URL signée Supabase.
 * Écriture unique : un fichier déjà stocké n'est jamais remplacé (son empreinte fait foi).
 */

export class AlreadyExists extends Error { constructor() { super('ALREADY_EXISTS'); } }
export class TooLarge extends Error { constructor() { super('FILE_TOO_LARGE'); } }

export type Body = Readable | ReadableStream<Uint8Array> | Buffer;

export interface BlobStore {
  put(key: string, body: Body, maxBytes: number, contentType?: string): Promise<{ size: number }>;
  exists(key: string): Promise<boolean>;
  size(key: string): Promise<number | null>;
  remove(keys: string[]): Promise<void>;
  /** Chemin d'une copie locale du fichier (pour ffmpeg). Le pilote local rend le fichier lui-même. */
  toLocalFile(key: string, tmpDir: string): Promise<string>;
  /** Où le navigateur envoie le fichier (PUT). */
  uploadTarget(key: string, maxBytes: number): Promise<string>;
  /** Réponse HTTP pour lire le fichier, une fois la signature de l'app vérifiée. */
  readResponse(key: string, req: Request, download: string | null): Promise<Response>;
}

const KEY_RE = /^[a-z0-9][a-z0-9/_.-]{0,300}$/i;

export function assertKey(key: string) {
  if (!KEY_RE.test(key) || key.includes('..') || key.includes('//')) throw new Error(`clé de stockage invalide : ${key}`);
}

export const contentTypeOf = (key: string) => ({
  mp3: 'audio/mpeg', wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff', flac: 'audio/flac',
  m4a: 'audio/mp4', json: 'application/json', zip: 'application/zip',
}[key.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream');

const toNodeStream = (body: Body) =>
  Buffer.isBuffer(body) ? Readable.from(body) : body instanceof Readable ? body : Readable.fromWeb(body as never);

async function* limit(src: AsyncIterable<Buffer>, max: number, counter: { n: number }) {
  for await (const chunk of src) {
    counter.n += chunk.length;
    if (counter.n > max) throw new TooLarge();
    yield chunk;
  }
}

// ───────────────────────── Pilote local ─────────────────────────

export function createLocalStore(rootDir: string): BlobStore & { pathOf(key: string): string } {
  const root = path.resolve(rootDir);
  const pathOf = (key: string) => {
    assertKey(key);
    const p = path.join(root, key);
    if (!p.startsWith(root + path.sep)) throw new Error('clé hors du stockage');
    return p;
  };
  const exists = (key: string) => stat(pathOf(key)).then((s) => s.isFile(), () => false);
  return {
    pathOf,
    exists,
    async put(key, body, maxBytes) {
      const dest = pathOf(key);
      if (await exists(key)) throw new AlreadyExists();
      await mkdir(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.part-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const counter = { n: 0 };
      try {
        await pipeline(toNodeStream(body), (src) => limit(src, maxBytes, counter), createWriteStream(tmp));
        if (await exists(key)) throw new AlreadyExists();
        await rename(tmp, dest);
      } finally {
        await rm(tmp, { force: true });
      }
      return { size: counter.n };
    },
    async size(key) { return stat(pathOf(key)).then((s) => s.size, () => null); },
    async remove(keys) { await Promise.all(keys.map((k) => rm(pathOf(k), { force: true }))); },
    async toLocalFile(key) { return pathOf(key); },
    async uploadTarget(key, maxBytes) {
      const t = uploadToken(key, maxBytes);
      const q = new URLSearchParams({ key, exp: String(t.exp), max: String(t.max), sig: t.sig });
      return `/api/uploads/data?${q}`;
    },
    async readResponse(key, req, download) {
      let file: string, total: number;
      try {
        file = pathOf(key);
        total = (await stat(file)).size;
      } catch {
        return new Response('Introuvable.', { status: 404 });
      }
      const headers: Record<string, string> = {
        'content-type': contentTypeOf(key), 'accept-ranges': 'bytes',
        'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff',
      };
      if (download) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(download)}`;
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '');
      if (m && (m[1] || m[2])) {
        const start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
        const end = Math.min(m[1] && m[2] ? Number(m[2]) : total - 1, total - 1);
        if (start > end || start >= total) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}` } });
        return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, {
          status: 206, headers: { ...headers, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${total}` },
        });
      }
      return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers: { ...headers, 'content-length': String(total) } });
    },
  };
}

// ───────────────────────── Pilote Supabase Storage ─────────────────────────

export function createSupabaseStore(cfg: { url: string; secretKey: string; bucket: string; fetch?: typeof fetch }): BlobStore {
  const f = cfg.fetch ?? fetch;
  const base = `${cfg.url.replace(/\/$/, '')}/storage/v1`;
  const auth = { authorization: `Bearer ${cfg.secretKey}`, apikey: cfg.secretKey };
  const obj = (key: string) => { assertKey(key); return `${cfg.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`; };
  const check = async (res: Response, what: string) => {
    if (res.ok) return res;
    const text = await res.text().catch(() => '');
    if (/duplicate|already exists/i.test(text) || res.status === 409) throw new AlreadyExists();
    if (res.status === 413 || /payload too large|maximum allowed size/i.test(text)) throw new TooLarge();
    throw new Error(`Supabase Storage ${what} : HTTP ${res.status} ${text.slice(0, 200)}`);
  };
  const head = (key: string) => f(`${base}/object/authenticated/${obj(key)}`, { method: 'HEAD', headers: auth });
  return {
    async put(key, body, maxBytes, contentType) {
      // On mesure et on borne le flux pendant l'envoi.
      const counter = { n: 0 };
      if (Buffer.isBuffer(body) && body.length > maxBytes) throw new TooLarge();
      const stream = Readable.toWeb(Readable.from(limit(toNodeStream(body), maxBytes, counter))) as ReadableStream;
      let res: Response;
      try {
        res = await f(`${base}/object/${obj(key)}`, {
          method: 'POST',
          headers: { ...auth, 'content-type': contentType ?? contentTypeOf(key), 'x-upsert': 'false', 'cache-control': 'private, max-age=300' },
          body: stream,
          duplex: 'half',
        } as RequestInit);
      } catch (e) {
        if (counter.n > maxBytes) throw new TooLarge();
        throw e;
      }
      await check(res, 'envoi');
      return { size: counter.n };
    },
    async exists(key) { return (await head(key)).ok; },
    async size(key) {
      const res = await head(key);
      return res.ok ? Number(res.headers.get('content-length') ?? 0) : null;
    },
    async remove(keys) {
      if (!keys.length) return;
      keys.forEach(assertKey);
      await check(await f(`${base}/object/${cfg.bucket}`, {
        method: 'DELETE', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: keys }),
      }), 'suppression');
    },
    async toLocalFile(key, tmpDir) {
      const res = await check(await f(`${base}/object/authenticated/${obj(key)}`, { headers: auth }), 'lecture');
      const dest = path.join(tmpDir, `src-${path.basename(key)}`);
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
      return dest;
    },
    async uploadTarget(key) {
      const res = await check(await f(`${base}/object/upload/sign/${obj(key)}`, { method: 'POST', headers: { ...auth, 'x-upsert': 'false' } }), 'URL d’envoi');
      const { url } = (await res.json()) as { url: string };
      return `${base}${url}`;
    },
    async readResponse(key, _req, download) {
      const res = await f(`${base}/object/sign/${obj(key)}`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ expiresIn: 600 }),
      });
      if (!res.ok) return new Response('Introuvable.', { status: 404 });
      const { signedURL } = (await res.json()) as { signedURL: string };
      const target = `${base}${signedURL}${download ? `&download=${encodeURIComponent(download)}` : ''}`;
      return new Response(null, { status: 302, headers: { location: target, 'cache-control': 'private, no-store' } });
    },
  };
}

// ───────────────────────── Accès courant ─────────────────────────

let cached: { sig: string; store: BlobStore } | null = null;

export function store(): BlobStore {
  const e = env();
  const sig = `${e.STORAGE_DRIVER}:${e.STORAGE_DIR}:${e.SUPABASE_URL ?? ''}:${e.SUPABASE_BUCKET}`;
  if (!cached || cached.sig !== sig) {
    cached = {
      sig,
      store: e.STORAGE_DRIVER === 'supabase'
        ? createSupabaseStore({ url: e.SUPABASE_URL!, secretKey: e.SUPABASE_SECRET_KEY!, bucket: e.SUPABASE_BUCKET })
        : createLocalStore(e.STORAGE_DIR),
    };
  }
  return cached.store;
}

export const putStream = (key: string, body: Body, maxBytes: number) => store().put(key, body, maxBytes);
export const putFile = (key: string, fromPath: string) => store().put(key, createReadStream(fromPath), Number.MAX_SAFE_INTEGER);
export const exists = (key: string) => store().exists(key);
export const size = (key: string) => store().size(key);
export const remove = (...keys: string[]) => store().remove(keys);

/** URL de lecture signée par l'app, valable `ttlSec` secondes. */
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

/** Jeton d'envoi du pilote local : autorise un PUT vers une clé précise, pendant `ttlSec`. */
export function uploadToken(key: string, maxBytes: number, ttlSec = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return { exp, max: maxBytes, sig: hmac(`put:${key}:${exp}:${maxBytes}`) };
}

export function verifyUploadToken(key: string, exp: number, max: number, sig: string) {
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  return safeEqualStr(sig, hmac(`put:${key}:${exp}:${max}`));
}
