import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Faux serveur Google (OpenID Connect) pour les tests et la recette : page de choix du compte,
 * échange de code avec vérification PKCE, clés publiques. Jamais utilisé en production.
 */
export async function startFakeGoogle(opts: { port?: number; clientId?: string; clientSecret?: string } = {}) {
  const clientId = opts.clientId ?? 'fake-client.apps.googleusercontent.com';
  const clientSecret = opts.clientSecret ?? 'GOCSPX-fake-secret';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomBytes(6).toString('hex');
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { email: string; nonce: string; challenge: string; redirectUri: string; verified: boolean }>();
  let base = '';

  const sign = (claims: Record<string, unknown>, k = { key: privateKey, kid }) => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = enc({ alg: 'RS256', kid: k.kid, typ: 'JWT' });
    const body = enc(claims);
    const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(k.key).toString('base64url');
    return `${head}.${body}.${sig}`;
  };
  const claimsFor = (email: string, nonce: string, extra: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return { iss: base, aud: clientId, sub: `g-${createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16)}`, email, email_verified: true, name: email.split('@')[0], nonce, iat: now, exp: now + 3600, ...extra };
  };

  const readBody = (req: http.IncomingMessage) => new Promise<URLSearchParams>((resolve) => {
    let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => resolve(new URLSearchParams(s)));
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const q = url.searchParams;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html lang="fr"><title>Faux Google</title><main><h1>Faux Google</h1>
        <form method="post" action="/authorize">
          ${['client_id', 'redirect_uri', 'state', 'nonce', 'code_challenge'].map((k) => `<input type="hidden" name="${k}" value="${(q.get(k) ?? '').replace(/"/g, '&quot;')}">`).join('')}
          <label>Adresse Google <input name="email" type="email" required></label>
          <label><input name="unverified" type="checkbox"> Adresse non vérifiée</label>
          <button>Continuer</button>
        </form></main></html>`);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/authorize') {
      const f = await readBody(req);
      if (f.get('client_id') !== clientId) { res.statusCode = 400; res.end('client inconnu'); return; }
      const code = randomBytes(16).toString('hex');
      codes.set(code, { email: f.get('email') ?? '', nonce: f.get('nonce') ?? '', challenge: f.get('code_challenge') ?? '', redirectUri: f.get('redirect_uri') ?? '', verified: !f.get('unverified') });
      const back = new URL(f.get('redirect_uri') ?? '');
      back.searchParams.set('code', code);
      back.searchParams.set('state', f.get('state') ?? '');
      res.statusCode = 302; res.setHeader('location', back.toString()); res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const f = await readBody(req);
      const c = codes.get(f.get('code') ?? '');
      codes.delete(f.get('code') ?? '');
      const verifier = f.get('code_verifier') ?? '';
      const okPkce = c && createHash('sha256').update(verifier).digest('base64url') === c.challenge;
      res.setHeader('content-type', 'application/json');
      if (!c || !okPkce || f.get('client_id') !== clientId || f.get('client_secret') !== clientSecret || f.get('redirect_uri') !== c.redirectUri) {
        res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid_grant' })); return;
      }
      res.end(JSON.stringify({ access_token: 'x', id_token: sign(claimsFor(c.email, c.nonce, { email_verified: c.verified })), token_type: 'Bearer' }));
      return;
    }
    if (url.pathname === '/jwks') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base, clientId, clientSecret, sign, claimsFor,
    env: { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_AUTH_URL: `${base}/authorize`, GOOGLE_TOKEN_URL: `${base}/token`, GOOGLE_JWKS_URL: `${base}/jwks`, GOOGLE_ISSUER: base },
    /** Simule le choix d'un compte sur la page Google ; renvoie l'adresse de retour (avec code et state). */
    async approve(authorizeUrl: string, email: string, verified = true) {
      const q = new URL(authorizeUrl).searchParams;
      const body = new URLSearchParams({ client_id: q.get('client_id') ?? '', redirect_uri: q.get('redirect_uri') ?? '', state: q.get('state') ?? '', nonce: q.get('nonce') ?? '', code_challenge: q.get('code_challenge') ?? '', email });
      if (!verified) body.set('unverified', 'on');
      const r = await fetch(`${base}/authorize`, { method: 'POST', body, redirect: 'manual' });
      return new URL(r.headers.get('location')!);
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
