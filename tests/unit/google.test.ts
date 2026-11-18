import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asService } from '@/lib/server/db';
import { googleCallback, googleConfig, googleStart, GoogleError, safeNext, signInGoogle, verifyIdToken } from '@/lib/server/google';
import { GET } from '@/app/api/auth/google/start/route';
import { userFromToken } from '@/lib/server/auth';
import { startFakeGoogle } from '../../scripts/fake-google';
import { makeUser } from './helpers';

let g: Awaited<ReturnType<typeof startFakeGoogle>>;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  g = await startFakeGoogle();
  for (const [k, v] of Object.entries(g.env)) { saved[k] = process.env[k]; process.env[k] = v; }
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await g.close();
});

async function fullFlow(email: string, opts: { verified?: boolean; next?: string } = {}) {
  const start = googleStart(opts.next);
  const back = await g.approve(start.url, email, opts.verified ?? true);
  return googleCallback({ code: back.searchParams.get('code'), state: back.searchParams.get('state') }, start.cookie);
}

describe('Connexion avec Google', () => {
  it('premier passage : compte créé, session ouverte, profil à créer', async () => {
    const email = `new_${Date.now()}@gmail.com`;
    const r = await fullFlow(email);
    expect(r.needsProfile).toBe(true);
    const u = await userFromToken(r.token);
    expect(u?.email).toBe(email);
  });

  it('même adresse qu’un compte existant : même compte, pas de doublon ; deuxième passage reconnu par Google', async () => {
    const mail = `exist_${Date.now()}@gmail.com`;
    const existing = await asService(async (tx) => {
      const [u] = await tx<{ id: string }[]>`insert into users (email) values (${mail}) returning id`;
      await tx`insert into profiles (user_id, handle, display_name) values (${u.id}, ${`ex_${Date.now() % 1e8}`}, 'Ex')`;
      return { id: u.id, email: mail };
    });
    const r = await fullFlow(existing.email);
    expect(r.userId).toBe(existing.id);
    expect(r.needsProfile).toBe(false);
    const again = await fullFlow(existing.email.toUpperCase());
    expect(again.userId).toBe(existing.id);
    const [{ n }] = await asService((tx) => tx<{ n: number }[]>`select count(*)::int as n from users where lower(email) = ${existing.email}`);
    expect(n).toBe(1);
  });

  it('destination après connexion : seulement un chemin interne', async () => {
    expect(safeNext('/s/abc')).toBe('/s/abc');
    for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', 'javascript:alert(1)', '']) expect(safeNext(bad)).toBeNull();
    const r = await fullFlow(`n_${Date.now()}@gmail.com`, { next: '/s/tok' });
    expect(r.next).toBe('/s/tok');
  });

  it('état (state) falsifié, absent ou cookie d’une autre tentative : refusé', async () => {
    const a = googleStart(null);
    const b = googleStart(null);
    const back = await g.approve(a.url, 'x@gmail.com');
    await expect(googleCallback({ code: back.searchParams.get('code'), state: 'faux' }, a.cookie)).rejects.toMatchObject({ code: 'bad_state' });
    await expect(googleCallback({ code: back.searchParams.get('code'), state: back.searchParams.get('state') }, b.cookie)).rejects.toMatchObject({ code: 'bad_state' });
    await expect(googleCallback({ code: back.searchParams.get('code'), state: back.searchParams.get('state') }, undefined)).rejects.toMatchObject({ code: 'bad_state' });
    const tampered = a.cookie.replace(/^./, (c) => (c === 'e' ? 'f' : 'e'));
    await expect(googleCallback({ code: back.searchParams.get('code'), state: back.searchParams.get('state') }, tampered)).rejects.toMatchObject({ code: 'bad_state' });
  });

  it('tentative expirée (plus de 10 min) : refusée', async () => {
    const a = googleStart(null, Date.now() - 11 * 60_000);
    const back = await g.approve(a.url, 'x@gmail.com');
    await expect(googleCallback({ code: back.searchParams.get('code'), state: back.searchParams.get('state') }, a.cookie)).rejects.toMatchObject({ code: 'expired' });
  });

  it('PKCE : un code volé ne s’échange pas sans le vérificateur d’origine', async () => {
    const a = googleStart(null);
    const b = googleStart(null);
    const back = await g.approve(a.url, 'pkce@gmail.com');
    // L'attaquant rejoue le code avec sa propre tentative (son cookie et son state) : le vérificateur ne correspond pas.
    const stateB = new URL(b.url).searchParams.get('state');
    await expect(googleCallback({ code: back.searchParams.get('code'), state: stateB }, b.cookie)).rejects.toMatchObject({ code: 'token' });
  });

  it('email non vérifié par Google : refusé', async () => {
    await expect(fullFlow(`unv_${Date.now()}@gmail.com`, { verified: false })).rejects.toMatchObject({ code: 'email_unverified' });
  });

  describe('jeton d’identité', () => {
    const nonce = 'n-123';
    it('accepté quand tout est bon', async () => {
      await expect(verifyIdToken(g.sign(g.claimsFor('ok@gmail.com', nonce)), nonce)).resolves.toMatchObject({ email: 'ok@gmail.com' });
    });
    it('signature d’une autre clé : refusé', async () => {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const bad = g.sign(g.claimsFor('a@gmail.com', nonce), { key: privateKey, kid: 'autre' });
      await expect(verifyIdToken(bad, nonce)).rejects.toBeInstanceOf(GoogleError);
      const forged = g.sign(g.claimsFor('a@gmail.com', nonce)).replace(/\.[^.]+$/, '.' + Buffer.from('x').toString('base64url'));
      await expect(verifyIdToken(forged, nonce)).rejects.toThrow('Signature invalide');
    });
    it('émetteur, audience, expiration, nonce : chacun refusé', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ iss: 'https://evil.example' }, 'Émetteur'],
        [{ aud: 'autre-client' }, 'Audience'],
        [{ exp: Math.floor(Date.now() / 1000) - 3600 }, 'expiré'],
        [{ nonce: 'autre' }, 'Nonce'],
      ];
      for (const [extra, msg] of cases) {
        await expect(verifyIdToken(g.sign({ ...g.claimsFor('a@gmail.com', nonce), ...extra }), nonce)).rejects.toThrow(msg);
      }
    });
    it('algorithme « none » : refusé', async () => {
      const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
      await expect(verifyIdToken(`${enc({ alg: 'none' })}.${enc(g.claimsFor('a@gmail.com', nonce))}.`, nonce)).rejects.toThrow('Algorithme');
    });
  });

  it('sans identifiants Google : désactivé (bouton absent, route 404)', async () => {
    const id = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    try {
      expect(googleConfig()).toBeNull();
      expect(() => googleStart(null)).toThrow(GoogleError);
      const res = await GET(new Request('http://localhost/api/auth/google/start'));
      expect(res.status).toBe(404);
    } finally { process.env.GOOGLE_CLIENT_ID = id; }
  });

  it('adresse hors Gmail d’un compte existant : pas de rattachement automatique (domaine racheté) ; domaine Workspace (hd) : rattaché', async () => {
    const other = await makeUser(); // adresse @test.local
    await expect(signInGoogle({ sub: `s-${Date.now()}`, email: other.email, name: null })).rejects.toMatchObject({ code: 'link_required' });
    const ws = await makeUser();
    const r = await signInGoogle({ sub: `w-${Date.now()}`, email: ws.email, name: null, hd: 'test.local' });
    expect(r.userId).toBe(ws.id);
    // Nouvelle adresse hors Gmail sans compte existant : création normale.
    const fresh = await signInGoogle({ sub: `f-${Date.now()}`, email: `neuf_${Date.now()}@exemple.fr`, name: null });
    expect(fresh.needsProfile).toBe(true);
  });

  it('adresse déjà liée à un autre compte Google : refusée, pas de prise de contrôle', async () => {
    const email = `taken_${Date.now()}@gmail.com`;
    await fullFlow(email);
    await expect(signInGoogle({ sub: 'autre-sub', email, name: null })).rejects.toMatchObject({ code: 'conflict' });
  });
});
