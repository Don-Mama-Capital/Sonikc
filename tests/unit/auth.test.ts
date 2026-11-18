import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuthError, createProfile, ProfileError, requestCode, revokeToken, userFromToken, verifyCode } from '@/lib/server/auth';
import { asService } from '@/lib/server/db';
import { lastCodeFor } from './mailbox';

const freshEmail = () => `${randomUUID().slice(0, 8)}@Example.com`;
const ip = () => `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

describe('Connexion sans mot de passe', () => {
  it('inscription puis connexion avec le code reçu par email', async () => {
    const email = freshEmail();
    await requestCode(email, ip());
    const code = await lastCodeFor(email);
    const first = await verifyCode(email, code);
    expect(first.needsProfile).toBe(true);
    const me = await userFromToken(first.token);
    expect(me?.email).toBe(email.toLowerCase());

    await createProfile(first.userId, 'Prod.Test_' + randomUUID().slice(0, 4), 'Prod Test');
    await revokeToken(first.token);
    expect(await userFromToken(first.token)).toBeNull();

    // Deuxième connexion : même compte, profil déjà là.
    await requestCode(email.toUpperCase(), ip());
    const second = await verifyCode(email, await lastCodeFor(email));
    expect(second.userId).toBe(first.userId);
    expect(second.needsProfile).toBe(false);
  });

  it('un code ne sert qu’une fois', async () => {
    const email = freshEmail();
    await requestCode(email, ip());
    const code = await lastCodeFor(email);
    await verifyCode(email, code);
    await expect(verifyCode(email, code)).rejects.toBeInstanceOf(AuthError);
  });

  it('un code expiré est refusé', async () => {
    const email = freshEmail();
    await requestCode(email, ip());
    const code = await lastCodeFor(email);
    await asService((tx) => tx`update login_codes set expires_at = now() - interval '1 second' where lower(email) = ${email.toLowerCase()}`);
    await expect(verifyCode(email, code)).rejects.toMatchObject({ code: 'expired' });
  });

  it('5 erreurs grillent le code, même le bon ne passe plus ensuite', async () => {
    const email = freshEmail();
    await requestCode(email, ip());
    const code = await lastCodeFor(email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 4; i++) await expect(verifyCode(email, wrong)).rejects.toMatchObject({ code: 'invalid_code' });
    await expect(verifyCode(email, wrong)).rejects.toMatchObject({ code: 'too_many_attempts' });
    await expect(verifyCode(email, code)).rejects.toBeInstanceOf(AuthError);
  });

  it('un nouveau code annule le précédent', async () => {
    const email = freshEmail();
    await requestCode(email, ip());
    const old = await lastCodeFor(email);
    await new Promise((r) => setTimeout(r, 5));
    await requestCode(email, ip());
    const fresh = await lastCodeFor(email);
    if (old !== fresh) await expect(verifyCode(email, old)).rejects.toBeInstanceOf(AuthError);
    await expect(verifyCode(email, fresh)).resolves.toMatchObject({ ok: true });
  });

  it('limite les demandes de code par adresse', async () => {
    const email = freshEmail();
    for (let i = 0; i < 5; i++) await requestCode(email, ip());
    await expect(requestCode(email, ip())).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('limite les demandes de code par adresse IP', async () => {
    const addr = ip();
    for (let i = 0; i < 20; i++) await requestCode(freshEmail(), addr);
    await expect(requestCode(freshEmail(), addr)).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('refuse une adresse invalide', async () => {
    await expect(requestCode('pas-un-email', ip())).rejects.toMatchObject({ code: 'invalid_email' });
  });

  it('un jeton inconnu ou trafiqué ne donne aucune session', async () => {
    expect(await userFromToken('n-importe-quoi')).toBeNull();
    expect(await userFromToken('')).toBeNull();
  });
});

describe('Profil et identifiant public', () => {
  async function newUser() {
    const email = freshEmail();
    await requestCode(email, ip());
    return (await verifyCode(email, await lastCodeFor(email))).userId;
  }

  it('un identifiant déjà pris est refusé, même avec une autre casse', async () => {
    const handle = 'dup_' + randomUUID().slice(0, 6);
    await createProfile(await newUser(), handle, 'A');
    await expect(createProfile(await newUser(), handle.toUpperCase(), 'B')).rejects.toThrow(/déjà pris/);
  });

  it('refuse les identifiants mal formés ou réservés', async () => {
    const u = await newUser();
    for (const bad of ['ab', 'avec espace', 'émile', 'admin', '.point', 'a..b', 'x'.repeat(31)]) {
      await expect(createProfile(u, bad, 'X')).rejects.toBeInstanceOf(ProfileError);
    }
  });

  it('accepte un @ devant et met en minuscules', async () => {
    const h = 'Beat_' + randomUUID().slice(0, 5);
    const p = await createProfile(await newUser(), '@' + h, '  Beat  ');
    expect(p).toEqual({ handle: h.toLowerCase(), displayName: 'Beat' });
  });
});
