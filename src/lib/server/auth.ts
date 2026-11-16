import { z } from 'zod';
import { asService, withUser } from './db';
import { hashCode, randomCode, randomToken, safeEqualHex, sha256 } from './crypto';
import { sendMail } from './mail';
import { handleProblem, normalizeHandle } from '../handle';

export const CODE_TTL_MIN = 10;
export const MAX_ATTEMPTS = 5;
export const SESSION_DAYS = 30;
const MAX_CODES_PER_EMAIL = 5; // par fenêtre de 15 min
const MAX_CODES_PER_IP = 20;
const MAX_FAILED_PER_EMAIL_HOUR = 10; // essais ratés cumulés, tous codes confondus

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export class AuthError extends Error {
  constructor(public code: 'rate_limited' | 'invalid_code' | 'expired' | 'too_many_attempts' | 'invalid_email', message: string) {
    super(message);
  }
}

/** Envoie un code à 6 chiffres. Répond pareil que l'adresse ait un compte ou non. */
export async function requestCode(rawEmail: string, ip: string) {
  const parsed = emailSchema.safeParse(rawEmail);
  if (!parsed.success) throw new AuthError('invalid_email', 'Adresse email invalide.');
  const email = parsed.data;
  const code = randomCode();
  await asService(async (tx) => {
    // Un verrou par adresse : deux demandes simultanées ne peuvent pas dépasser la limite.
    await tx`select pg_advisory_xact_lock(hashtext(${`login:${email}`}))`;
    const [{ byEmail, byIp, failed }] = await tx<{ byEmail: number; byIp: number; failed: number }[]>`
      select
        count(*) filter (where lower(email) = ${email} and created_at > now() - interval '15 minutes')::int as "byEmail",
        count(*) filter (where ip = ${ip} and ip <> 'unknown' and created_at > now() - interval '15 minutes')::int as "byIp",
        coalesce(sum(attempts) filter (where lower(email) = ${email}), 0)::int as failed
      from login_codes where created_at > now() - interval '1 hour'`;
    if (byEmail >= MAX_CODES_PER_EMAIL || byIp >= MAX_CODES_PER_IP || failed >= MAX_FAILED_PER_EMAIL_HOUR) {
      throw new AuthError('rate_limited', 'Trop de demandes. Réessaie dans quelques minutes.');
    }
    // Un seul code valide à la fois : les précédents sont annulés.
    await tx`update login_codes set consumed_at = now() where lower(email) = ${email} and consumed_at is null`;
    await tx`insert into login_codes (email, code_hash, expires_at, ip)
             values (${email}, ${hashCode(email, code)}, now() + ${`${CODE_TTL_MIN} minutes`}::interval, ${ip})`;
  });
  await sendMail({
    to: email,
    tag: 'login_code',
    subject: `Ton code Sonikc : ${code}`,
    text: `Ton code de connexion Sonikc est ${code}.\nIl expire dans ${CODE_TTL_MIN} minutes. Si tu n'as rien demandé, ignore cet email.`,
  });
}

/** Vérifie le code ; crée le compte au premier passage ; ouvre une session. */
export async function verifyCode(rawEmail: string, rawCode: string) {
  const email = emailSchema.parse(rawEmail);
  const code = rawCode.replace(/\s/g, '');
  return asService(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`login:${email}`}))`;
    const [{ failed }] = await tx<{ failed: number }[]>`
      select coalesce(sum(attempts), 0)::int as failed from login_codes
      where lower(email) = ${email} and created_at > now() - interval '1 hour'`;
    if (failed >= MAX_FAILED_PER_EMAIL_HOUR) {
      await tx`update login_codes set consumed_at = now() where lower(email) = ${email} and consumed_at is null`;
      return { ok: false as const, error: 'too_many_attempts' as const };
    }
    const [row] = await tx<{ id: string; code_hash: string; expires_at: Date; attempts: number }[]>`
      select id, code_hash, expires_at, attempts from login_codes
      where lower(email) = ${email} and consumed_at is null
      order by created_at desc limit 1 for update`;
    if (!row) throw new AuthError('invalid_code', 'Code invalide. Demande-en un nouveau.');
    if (row.attempts >= MAX_ATTEMPTS) throw new AuthError('too_many_attempts', 'Trop d’essais. Demande un nouveau code.');
    if (row.expires_at.getTime() < Date.now()) throw new AuthError('expired', 'Ce code a expiré. Demande-en un nouveau.');
    if (!/^\d{6}$/.test(code) || !safeEqualHex(row.code_hash, hashCode(email, code))) {
      const attempts = row.attempts + 1;
      await tx`update login_codes set attempts = ${attempts},
               consumed_at = case when ${attempts} >= ${MAX_ATTEMPTS} then now() else null end
               where id = ${row.id}`;
      // L'erreur est renvoyée après l'enregistrement de l'essai (la transaction est validée).
      return { ok: false as const, error: attempts >= MAX_ATTEMPTS ? 'too_many_attempts' as const : 'invalid_code' as const };
    }
    await tx`update login_codes set consumed_at = now() where id = ${row.id}`;
    await tx`insert into users (email) values (${email}) on conflict (lower(email)) do nothing`;
    const [user] = await tx<{ id: string }[]>`select id from users where lower(email) = ${email}`;
    const token = randomToken();
    await tx`insert into sessions (user_id, token_hash, expires_at)
             values (${user.id}, ${sha256(token)}, now() + ${`${SESSION_DAYS} days`}::interval)`;
    const [p] = await tx`select 1 from profiles where user_id = ${user.id}`;
    return { ok: true as const, token, userId: user.id, needsProfile: !p };
  }).then((r) => {
    if (!r.ok) throw new AuthError(r.error, r.error === 'too_many_attempts' ? 'Trop d’essais. Demande un nouveau code.' : 'Code incorrect.');
    return r;
  });
}

export type SessionUser = { id: string; email: string; handle: string | null; displayName: string | null; keyNotation: 'sharps' | 'flats' };

export async function userFromToken(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token || token.length > 100) return null;
  return asService(async (tx) => {
    const [row] = await tx<{ id: string; email: string; handle: string | null; display_name: string | null; key_notation: 'sharps' | 'flats' | null; session_id: string; last_seen_at: Date }[]>`
      select u.id, u.email, p.handle, p.display_name, p.key_notation, s.id as session_id, s.last_seen_at
      from sessions s join users u on u.id = s.user_id left join profiles p on p.user_id = u.id
      where s.token_hash = ${sha256(token)} and s.expires_at > now()`;
    if (!row) return null;
    if (Date.now() - row.last_seen_at.getTime() > 3600_000) {
      await tx`update sessions set last_seen_at = now() where id = ${row.session_id}`;
    }
    return { id: row.id, email: row.email, handle: row.handle, displayName: row.display_name, keyNotation: row.key_notation ?? 'sharps' };
  });
}

export async function revokeToken(token: string | undefined | null) {
  if (!token) return;
  await asService((tx) => tx`delete from sessions where token_hash = ${sha256(token)}`);
}

export class ProfileError extends Error {
  constructor(public field: 'handle' | 'displayName', message: string) { super(message); }
}

/** Crée le profil public. L'unicité du handle est garantie par un index unique, sans course possible. */
export async function createProfile(userId: string, rawHandle: string, rawDisplayName: string) {
  const handle = normalizeHandle(rawHandle);
  const problem = handleProblem(handle);
  if (problem) throw new ProfileError('handle', problem);
  const displayName = rawDisplayName.trim().slice(0, 60);
  if (!displayName) throw new ProfileError('displayName', 'Indique un nom à afficher.');
  try {
    await withUser(userId, (tx) =>
      tx`insert into profiles (user_id, handle, display_name) values (${userId}, ${handle}, ${displayName})`);
  } catch (e) {
    const msg = String((e as Error).message);
    if (msg.includes('profiles_handle_key')) throw new ProfileError('handle', 'Cet identifiant est déjà pris.');
    if (msg.includes('profiles_pkey')) throw new ProfileError('handle', 'Ton profil existe déjà.');
    throw e;
  }
  return { handle, displayName };
}
