import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_DAYS, userFromToken, type SessionUser } from './auth';
import { isProd } from './env';

export const SESSION_COOKIE = 'sk_session';

export async function currentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  return userFromToken(jar.get(SESSION_COOKIE)?.value);
}

/** Pour les pages de l'app : redirige vers la connexion, puis vers l'onboarding si le profil manque. */
export async function requireUser(opts: { allowNoProfile?: boolean } = {}): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect('/login');
  if (!user.handle && !opts.allowNoProfile) redirect('/onboarding');
  return user;
}

export async function setSessionCookie(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd(),
    path: '/',
    maxAge: SESSION_DAYS * 24 * 3600,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

/**
 * Adresse IP du client, uniquement depuis l'en-tête posé par l'hébergeur (TRUSTED_IP_HEADER,
 * par ex. « x-real-ip » sur Vercel). Sans cet en-tête configuré, on ne fait confiance à rien :
 * X-Forwarded-For est choisi par le client et ne doit pas servir aux limites de débit.
 */
export async function clientIp() {
  const name = process.env.TRUSTED_IP_HEADER?.toLowerCase();
  if (!name) return 'unknown';
  const h = await headers();
  const v = h.get(name);
  // Avec X-Forwarded-For, seule la dernière valeur est ajoutée par le proxy de confiance.
  return v?.split(',').at(-1)?.trim() || 'unknown';
}
