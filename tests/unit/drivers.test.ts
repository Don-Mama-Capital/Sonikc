import http from 'node:http';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Zip, ZipPassThrough } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlreadyExists, createSupabaseStore, TooLarge } from '@/lib/server/storage';
import { sendMail } from '@/lib/server/mail';
import { env } from '@/lib/server/env';
import { extractZip } from '@/lib/server/processing';

// ── Simulation de l'API Supabase Storage (le sous-ensemble utilisé par Sonikc) ──
const SECRET = 'sb_secret_test_test_test_test_test';
const blobs = new Map<string, Buffer>();
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const u = new URL(req.url!, 'http://x');
    const p = decodeURIComponent(u.pathname);
    const body = await new Promise<Buffer>((r) => { const c: Buffer[] = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
    const authed = req.headers.authorization === `Bearer ${SECRET}` && req.headers.apikey === SECRET;
    const send = (status: number, data?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(data === undefined ? undefined : typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
    };
    let m: RegExpExecArray | null;
    if ((m = /^\/storage\/v1\/object\/upload\/sign\/audio\/(.+)$/.exec(p))) {
      if (req.method === 'POST') return authed ? send(200, { url: `/object/upload/sign/audio/${m[1]}?token=up-${m[1]}` }) : send(401);
      if (req.method === 'PUT') {
        if (u.searchParams.get('token') !== `up-${m[1]}`) return send(403);
        if (blobs.has(m[1])) return send(400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
        blobs.set(m[1], body); return send(200, { Key: `audio/${m[1]}` });
      }
    }
    if ((m = /^\/storage\/v1\/object\/sign\/audio\/(.+)$/.exec(p))) {
      if (req.method === 'POST') return authed && blobs.has(m[1]) ? send(200, { signedURL: `/object/sign/audio/${m[1]}?token=get-${m[1]}` }) : send(400, { error: 'not_found' });
      if (req.method === 'GET') return u.searchParams.get('token') === `get-${m[1]}` ? send(200, blobs.get(m[1])) : send(403);
    }
    if ((m = /^\/storage\/v1\/object\/authenticated\/audio\/(.+)$/.exec(p))) {
      if (!authed) return send(401);
      const b = blobs.get(m[1]);
      if (!b) return send(400, req.method === 'HEAD' ? undefined : { error: 'not_found' });
      return send(200, req.method === 'HEAD' ? undefined : b, { 'content-length': String(b.length) });
    }
    if (p === '/storage/v1/object/audio' && req.method === 'DELETE') {
      if (!authed) return send(401);
      for (const k of JSON.parse(body.toString()).prefixes) blobs.delete(k);
      return send(200, []);
    }
    if ((m = /^\/storage\/v1\/object\/audio\/(.+)$/.exec(p)) && req.method === 'POST') {
      if (!authed) return send(401);
      if (req.headers['x-upsert'] !== 'false') return send(400, { error: 'expected x-upsert false' });
      if (blobs.has(m[1])) return send(400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
      blobs.set(m[1], body); return send(200, { Key: `audio/${m[1]}` });
    }
    send(404, { error: `route inconnue ${req.method} ${p}` });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address() as { port: number };
  base = `http://127.0.0.1:${a.port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('Pilote Supabase Storage (contre une simulation de l’API)', () => {
  const sb = () => createSupabaseStore({ url: base, secretKey: SECRET, bucket: 'audio' });

  it('envoie, mesure, lit en local, supprime', async () => {
    const s = sb();
    const key = 'u/abc/t/1/v/2/original.wav';
    expect(await s.exists(key)).toBe(false);
    expect(await s.put(key, Buffer.from('RIFF-données'), 1000)).toEqual({ size: Buffer.byteLength('RIFF-données') });
    expect(await s.exists(key)).toBe(true);
    expect(await s.size(key)).toBe(Buffer.byteLength('RIFF-données'));
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'sb-'));
    expect((await readFile(await s.toLocalFile(key, tmp))).toString()).toBe('RIFF-données');
    await s.remove([key]);
    expect(await s.exists(key)).toBe(false);
  });

  it('écriture unique : un deuxième envoi sur la même clé est refusé', async () => {
    const s = sb();
    await s.put('u/x/dup.mp3', Buffer.from('a'), 10);
    await expect(s.put('u/x/dup.mp3', Buffer.from('b'), 10)).rejects.toBeInstanceOf(AlreadyExists);
    expect(blobs.get('u/x/dup.mp3')!.toString()).toBe('a');
  });

  it('taille maximale respectée pendant l’envoi', async () => {
    await expect(sb().put('u/x/big.wav', Buffer.alloc(2000), 1000)).rejects.toBeInstanceOf(TooLarge);
    expect(blobs.has('u/x/big.wav')).toBe(false);
  });

  it('URL d’envoi signée utilisable par le navigateur (PUT), une seule fois', async () => {
    const target = await sb().uploadTarget('u/x/browser.flac', 1000);
    expect(target.startsWith(`${base}/storage/v1/object/upload/sign/audio/`)).toBe(true);
    expect((await fetch(target, { method: 'PUT', body: 'flac!' })).status).toBe(200);
    expect((await fetch(target, { method: 'PUT', body: 'autre' })).status).not.toBe(200);
    expect(blobs.get('u/x/browser.flac')!.toString()).toBe('flac!');
  });

  it('lecture : redirection vers une URL signée Supabase, avec nom de téléchargement', async () => {
    const s = sb();
    await s.put('u/x/play.mp3', Buffer.from('ID3'), 10);
    const res = await s.readResponse('u/x/play.mp3', new Request('http://app/'), 'Mon beat.mp3');
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc).toMatch(/\/storage\/v1\/object\/sign\/audio\/u\/x\/play\.mp3\?token=.+&download=Mon%20beat\.mp3$/);
    expect(await (await fetch(loc)).text()).toBe('ID3');
    expect((await s.readResponse('u/x/absent.mp3', new Request('http://app/'), null)).status).toBe(404);
  });

  it('une mauvaise clé secrète est refusée par le service', async () => {
    const bad = createSupabaseStore({ url: base, secretKey: 'faux-faux-faux-faux-faux', bucket: 'audio' });
    await expect(bad.put('u/x/nope.wav', Buffer.from('a'), 10)).rejects.toThrow(/HTTP 401/);
  });

  it('refuse les clés dangereuses', async () => {
    await expect(sb().put('../etc/passwd', Buffer.from('a'), 10)).rejects.toThrow(/invalide/);
  });
});

describe('Pilote email Resend', () => {
  const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void> | void) => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };

  it('envoie la bonne requête à l’API Resend', async () => {
    await withEnv({ MAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test_123', MAIL_FROM: 'Sonikc <onboarding@resend.dev>' }, async () => {
      let seen: { url: string; init: RequestInit } | null = null;
      const fakeFetch = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response('{"id":"1"}', { status: 200 }); }) as typeof fetch;
      await sendMail({ to: 'a@b.fr', subject: 'Ton code', text: 'Code 123456', tag: 'login_code' }, { fetch: fakeFetch });
      expect(seen!.url).toBe('https://api.resend.com/emails');
      expect((seen!.init.headers as Record<string, string>).authorization).toBe('Bearer re_test_123');
      expect(JSON.parse(String(seen!.init.body))).toEqual({
        from: 'Sonikc <onboarding@resend.dev>', to: ['a@b.fr'], subject: 'Ton code', text: 'Code 123456',
        tags: [{ name: 'category', value: 'login_code' }],
      });
    });
  });

  it('un refus de Resend remonte une erreur claire', async () => {
    await withEnv({ MAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test_123' }, async () => {
      const fakeFetch = (async () => new Response('domain not verified', { status: 403 })) as unknown as typeof fetch;
      await expect(sendMail({ to: 'a@b.fr', subject: 's', text: 't' }, { fetch: fakeFetch })).rejects.toThrow(/HTTP 403/);
    });
  });

  it('configuration : Resend sans clé, ou pilotes locaux en production, sont refusés au démarrage', async () => {
    await withEnv({ MAIL_DRIVER: 'resend', RESEND_API_KEY: undefined }, () => { expect(() => env()).toThrow(/RESEND_API_KEY/); });
    await withEnv({ NODE_ENV: 'production', ALLOW_LOCAL_DRIVERS: undefined }, () => { expect(() => env()).toThrow(/En production/); });
    await withEnv({ STORAGE_DRIVER: 'supabase', SUPABASE_URL: undefined }, () => { expect(() => env()).toThrow(/SUPABASE_URL/); });
  });
});

describe('ZIP déballé en flux', () => {
  it('une archive de 120 Mo est déballée sans la charger en mémoire', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zipflux-'));
    const zipPath = path.join(dir, 'gros.zip');
    // Archive « stockée » (sans compression) écrite en flux : 3 fichiers de 40 Mo.
    const out = createWriteStream(zipPath);
    const zip = new Zip((err, chunk, final) => { if (err) throw err; out.write(chunk); if (final) out.end(); });
    const block = Buffer.alloc(1024 * 1024, 7);
    for (const name of ['a/un.wav', 'a/deux.wav', 'trois.wav']) {
      const f = new ZipPassThrough(name);
      zip.add(f);
      for (let i = 0; i < 40; i++) f.push(block, i === 39);
    }
    zip.end();
    await new Promise<void>((r) => out.on('finish', () => r()));
    global.gc?.();
    const before = process.memoryUsage();
    let peak = 0;
    const timer = setInterval(() => { const m = process.memoryUsage(); peak = Math.max(peak, m.heapUsed + m.arrayBuffers - before.heapUsed - before.arrayBuffers); }, 5);
    const entries = await extractZip(zipPath, dir);
    clearInterval(timer);
    expect(entries.map((e) => [e.name, e.size])).toEqual([['a/un.wav', 40 * 1024 ** 2], ['a/deux.wav', 40 * 1024 ** 2], ['trois.wav', 40 * 1024 ** 2]]);
    expect(peak).toBeLessThan(60 * 1024 ** 2);
    expect((await readFile(entries[2].file)).subarray(0, 4)).toEqual(Buffer.from([7, 7, 7, 7]));
  });

  it('une archive corrompue est refusée proprement', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zipbad-'));
    const p = path.join(dir, 'bad.zip');
    await writeFile(p, Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(100, 1)]));
    await expect(extractZip(p, dir)).rejects.toThrow(/illisible/);
  });
});
