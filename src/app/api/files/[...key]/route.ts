import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { localPath, verifySignedGet } from '@/lib/server/storage';

const TYPES: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff', flac: 'audio/flac',
  m4a: 'audio/mp4', json: 'application/json', zip: 'application/zip',
};

/** Sert un fichier privé si l'URL est signée et pas expirée. Gère les requêtes Range (avance rapide dans le lecteur). */
export async function GET(req: Request, ctx: { params: Promise<{ key: string[] }> }) {
  const { key: parts } = await ctx.params;
  const key = parts.map(decodeURIComponent).join('/');
  const url = new URL(req.url);
  const dl = url.searchParams.get('dl');
  if (!verifySignedGet(key, url.searchParams.get('exp'), url.searchParams.get('sig'), dl)) {
    return new Response('Lien expiré ou invalide.', { status: 403 });
  }
  let file: string;
  let total: number;
  try {
    file = localPath(key);
    total = (await stat(file)).size;
  } catch {
    return new Response('Introuvable.', { status: 404 });
  }
  const type = TYPES[key.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';
  const headers: Record<string, string> = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=300',
    'x-content-type-options': 'nosniff',
  };
  if (dl) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(dl)}`;

  const range = req.headers.get('range');
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
    let end = m[1] && m[2] ? Number(m[2]) : total - 1;
    end = Math.min(end, total - 1);
    if (start > end || start >= total) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}` } });
    }
    const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
    return new Response(body, {
      status: 206,
      headers: { ...headers, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${total}` },
    });
  }
  const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(body, { headers: { ...headers, 'content-length': String(total) } });
}
