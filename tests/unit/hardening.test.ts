import { randomUUID } from 'node:crypto';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { requestCode, verifyCode } from '@/lib/server/auth';
import { asService, withUser } from '@/lib/server/db';
import { sameOrigin } from '@/lib/server/http';
import { startUpload, completeUpload } from '@/lib/server/uploads';
import { PUT } from '@/app/api/uploads/data/route';
import { drain } from '../../worker/index';
import { lastCodeFor } from './mailbox';
import { makeUser } from './helpers';

const email = () => `${randomUUID().slice(0, 8)}@harden.test`;

describe('Durcissement après relecture de sécurité', () => {
  it('des demandes de code simultanées ne dépassent pas la limite de 5', async () => {
    const e = email();
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => requestCode(e, `10.9.9.${i}`)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    const [{ n }] = await asService((tx) => tx<{ n: number }[]>`select count(*)::int as n from login_codes where lower(email) = ${e}`);
    expect(n).toBe(5);
  });

  it('10 erreurs cumulées sur une heure bloquent l’adresse, même avec de nouveaux codes', async () => {
    const e = email();
    for (let round = 0; round < 2; round++) {
      await requestCode(e, 'unknown');
      const good = await lastCodeFor(e);
      const wrong = good === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) await verifyCode(e, wrong).catch(() => {});
    }
    await expect(requestCode(e, 'unknown')).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('la version courante d’un morceau doit être une de ses versions', async () => {
    const u = await makeUser();
    await expect(withUser(u.id, async (tx) => {
      const [a] = await tx<{ id: string }[]>`insert into tracks (owner_id, title) values (${u.id}, 'A') returning id`;
      const [b] = await tx<{ id: string }[]>`insert into tracks (owner_id, title) values (${u.id}, 'B') returning id`;
      const [v] = await tx<{ id: string }[]>`insert into track_versions (track_id, owner_id, version_no, label, original_filename, original_key)
        values (${b.id}, ${u.id}, 1, 'v1', 'b.wav', 'x') returning id`;
      await tx`update tracks set current_version_id = ${v.id} where id = ${a.id}`;
    })).rejects.toThrow(/another track/);
  });

  it('un fichier reçu ne peut pas être remplacé (écriture unique)', async () => {
    const u = await makeUser();
    const t = await startUpload(u.id, { filename: 'beat.wav', size: 10 });
    const put = () => PUT(new Request(`http://localhost${t.uploadUrl}`, { method: 'PUT', body: new Uint8Array([1, 2, 3]) }));
    expect((await put()).status).toBe(200);
    expect((await put()).status).toBe(409);
  });

  it('une archive ZIP trop grosse une fois décompressée est refusée proprement', async () => {
    const u = await makeUser();
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i < 201; i++) entries[`f${i}.wav`] = new Uint8Array([i % 256]);
    const zip = zipSync(entries);
    const t = await startUpload(u.id, { filename: 'gros.zip', size: zip.length });
    const res = await PUT(new Request(`http://localhost${t.uploadUrl}`, { method: 'PUT', body: zip }));
    expect(res.status).toBe(200);
    await completeUpload(u.id, t.kind, t.id);
    await drain();
    const [im] = await asService((tx) => tx<{ status: string; error: string }[]>`select status, error from imports where id = ${t.id}`);
    expect(im.status).toBe('failed');
    expect(im.error).toMatch(/trop volumineuse/);
  });

  it('une écriture venue d’un autre site sans en-tête Origin est refusée', () => {
    expect(sameOrigin(new Request('http://localhost/api/x', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } }))).toBe(false);
    expect(sameOrigin(new Request('http://localhost/api/x', { method: 'POST', headers: { origin: 'https://evil.example' } }))).toBe(false);
    expect(sameOrigin(new Request('http://localhost/api/x', { method: 'POST', headers: { origin: 'http://localhost' } }))).toBe(true);
    expect(sameOrigin(new Request('http://localhost/api/x', { method: 'POST' }))).toBe(true);
  });
});
