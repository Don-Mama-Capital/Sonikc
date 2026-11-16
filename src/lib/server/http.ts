import { NextResponse } from 'next/server';
import { currentUser } from './session';
import type { SessionUser } from './auth';

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status });
export const fail = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error, ...extra }, { status });

/** Garde des routes API : 401 sans session, 403 sans profil. */
export async function apiUser(): Promise<SessionUser | NextResponse> {
  const user = await currentUser();
  if (!user) return fail(401, 'Connexion requise.');
  if (!user.handle) return fail(403, 'Termine ton profil d’abord.');
  return user;
}

/** Vérifie qu'une requête qui modifie vient bien de notre propre origine (anti-CSRF, en plus de SameSite=Lax). */
export function sameOrigin(req: Request) {
  const origin = req.headers.get('origin');
  if (!origin) return req.headers.get('sec-fetch-site') !== 'cross-site'; // outils sans navigateur : la session reste exigée
  try {
    return new URL(origin).host === new URL(req.url).host || origin === process.env.APP_URL;
  } catch {
    return false;
  }
}
