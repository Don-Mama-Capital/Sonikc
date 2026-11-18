import { createHash, createPublicKey, verify as verifySig, type JsonWebKey } from 'node:crypto';
import { asService } from './db';
import { hmac, randomToken, safeEqualStr, sha256 } from './crypto';
import { env } from './env';
import { SESSION_DAYS } from './auth';

/**
 * Connexion avec Google (OpenID Connect, « authorization code » + PKCE).
 * Protections : état (anti-CSRF), PKCE, nonce, jeton d'identité vérifié (signature RS256 via les clés publiques
 * de Google, émetteur, audience, expiration), email vérifié exigé.
 * Les adresses des serveurs Google sont réglables pour les tests (faux serveur Google).
 */
export const OAUTH_COOKIE = 'sk_oauth';
const COOKIE_TTL_S = 600;

export class GoogleError extends Error {
  constructor(public code: 'not_configured' | 'bad_state' | 'expired' | 'token' | 'id_token' | 'email_unverified' | 'conflict', message: string) {
    super(message);
  }
}

export function googleConfig() {
  const e = process.env;
  if (!e.GOOGLE_CLIENT_ID || !e.GOOGLE_CLIENT_SECRET) return null;
  return {
    clientId: e.GOOGLE_CLIENT_ID,
    clientSecret: e.GOOGLE_CLIENT_SECRET,
    authUrl: e.GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: e.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
    jwksUrl: e.GOOGLE_JWKS_URL ?? 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: (e.GOOGLE_ISSUER ?? 'https://accounts.google.com,accounts.google.com').split(','),
    redirectUri: `${env().APP_URL.replace(/\/$/, '')}/api/auth/google/callback`,
  };
}

/** N'accepte qu'un chemin interne (« /s/… », « /app ») comme destination après connexion. */
export function safeNext(next: unknown) {
  const s = typeof next === 'string' ? next : '';
  return /^\/(?!\/)[\w\-./?=&%]*$/.test(s) && !s.includes('\\') ? s : null;
}

type OAuthState = { state: string; verifier: string; nonce: string; next: string | null; exp: number };

const seal = (o: OAuthState) => { const p = Buffer.from(JSON.stringify(o)).toString('base64url'); return `${p}.${hmac(`oauth:${p}`)}`; };
function unseal(v: string | undefined): OAuthState | null {
  if (!v) return null;
  const [p, mac] = v.split('.');
  if (!p || !mac || !safeEqualStr(mac, hmac(`oauth:${p}`))) return null;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
}

/** Prépare la redirection vers Google ; renvoie l'adresse et la valeur du cookie temporaire. */
export function googleStart(nextPath: unknown, now = Date.now()) {
  const cfg = googleConfig();
  if (!cfg) throw new GoogleError('not_configured', 'Connexion Google non configurée.');
  const st: OAuthState = { state: randomToken(24), verifier: randomToken(48), nonce: randomToken(24), next: safeNext(nextPath), exp: now + COOKIE_TTL_S * 1000 };
  const url = new URL(cfg.authUrl);
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: st.state,
    nonce: st.nonce,
    code_challenge: createHash('sha256').update(st.verifier).digest('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return { url: url.toString(), cookie: seal(st), maxAge: COOKIE_TTL_S };
}

let jwksCache: { url: string; at: number; keys: (JsonWebKey & { kid?: string })[] } | null = null;
async function jwks(url: string, force = false) {
  if (!force && jwksCache?.url === url && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const res = await fetch(url);
  if (!res.ok) throw new GoogleError('id_token', 'Clés Google indisponibles.');
  const { keys } = await res.json();
  jwksCache = { url, at: Date.now(), keys };
  return keys as (JsonWebKey & { kid?: string })[];
}

export type GoogleIdentity = { sub: string; email: string; name: string | null };

/** Vérifie un jeton d'identité Google. Exporté pour les tests. */
export async function verifyIdToken(idToken: string, expectedNonce: string, now = Date.now()): Promise<GoogleIdentity> {
  const cfg = googleConfig()!;
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new GoogleError('id_token', 'Jeton Google illisible.');
  let header: { alg?: string; kid?: string }; let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch { throw new GoogleError('id_token', 'Jeton Google illisible.'); }
  if (header.alg !== 'RS256') throw new GoogleError('id_token', 'Algorithme refusé.');
  let key = (await jwks(cfg.jwksUrl)).find((k) => k.kid === header.kid);
  if (!key) key = (await jwks(cfg.jwksUrl, true)).find((k) => k.kid === header.kid); // rotation des clés
  if (!key) throw new GoogleError('id_token', 'Clé de signature inconnue.');
  const ok = verifySig('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new GoogleError('id_token', 'Signature invalide.');
  const sec = Math.floor(now / 1000);
  if (!cfg.issuers.includes(String(claims.iss))) throw new GoogleError('id_token', 'Émetteur refusé.');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(cfg.clientId)) throw new GoogleError('id_token', 'Audience refusée.');
  if (typeof claims.exp !== 'number' || claims.exp < sec - 60) throw new GoogleError('id_token', 'Jeton expiré.');
  if (typeof claims.iat === 'number' && claims.iat > sec + 300) throw new GoogleError('id_token', 'Jeton daté dans le futur.');
  if (typeof claims.nonce !== 'string' || !safeEqualStr(claims.nonce, expectedNonce)) throw new GoogleError('id_token', 'Nonce invalide.');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new GoogleError('email_unverified', 'Adresse Google non vérifiée.');
  if (typeof claims.sub !== 'string' || typeof claims.email !== 'string') throw new GoogleError('id_token', 'Jeton incomplet.');
  return { sub: claims.sub, email: claims.email.trim().toLowerCase(), name: typeof claims.name === 'string' ? claims.name : null };
}

/** Retour de Google : échange le code, vérifie l'identité, ouvre une session. */
export async function googleCallback(params: { code?: string | null; state?: string | null; error?: string | null }, cookieValue: string | undefined, now = Date.now()) {
  const cfg = googleConfig();
  if (!cfg) throw new GoogleError('not_configured', 'Connexion Google non configurée.');
  const st = unseal(cookieValue);
  if (!st || !params.state || !safeEqualStr(st.state, params.state)) throw new GoogleError('bad_state', 'Session de connexion invalide. Recommence.');
  if (st.exp < now) throw new GoogleError('expired', 'Connexion trop longue. Recommence.');
  if (params.error || !params.code) throw new GoogleError('token', 'Connexion Google annulée.');
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: params.code, client_id: cfg.clientId, client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri, grant_type: 'authorization_code', code_verifier: st.verifier,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.id_token !== 'string') throw new GoogleError('token', 'Google a refusé la connexion.');
  const who = await verifyIdToken(data.id_token, st.nonce, now);
  const session = await signInGoogle(who);
  return { ...session, next: st.next };
}

/** Trouve ou crée le compte : d'abord par identifiant Google, sinon par email vérifié (même compte, pas de doublon). */
export async function signInGoogle(who: GoogleIdentity) {
  return asService(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`login:${who.email}`}))`;
    let [user] = await tx<{ id: string }[]>`select id from users where google_sub = ${who.sub}`;
    if (!user) {
      const [byEmail] = await tx<{ id: string; google_sub: string | null }[]>`select id, google_sub from users where lower(email) = ${who.email}`;
      if (byEmail?.google_sub && byEmail.google_sub !== who.sub) {
        throw new GoogleError('conflict', 'Cette adresse est déjà liée à un autre compte Google.');
      }
      if (byEmail) {
        await tx`update users set google_sub = ${who.sub} where id = ${byEmail.id}`;
        user = byEmail;
      } else {
        [user] = await tx<{ id: string }[]>`insert into users (email, google_sub) values (${who.email}, ${who.sub}) returning id`;
      }
    }
    const token = randomToken();
    await tx`insert into sessions (user_id, token_hash, expires_at) values (${user.id}, ${sha256(token)}, now() + ${`${SESSION_DAYS} days`}::interval)`;
    const [p] = await tx`select 1 from profiles where user_id = ${user.id}`;
    return { token, userId: user.id, needsProfile: !p };
  });
}
