import { cookies } from 'next/headers';
import { fail, json, sameOrigin } from '@/lib/server/http';
import { isProd } from '@/lib/server/env';
import { CONSENT_COOKIE, CONSENT_DAYS } from '@/config/cookies';
import { VISITOR_COOKIE } from '@/lib/server/listener-http';

/** Choix sur les cookies : { choice: 'accepted' | 'refused' }. Refuser efface aussitôt le cookie de mesure. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail(403, 'Origine refusée.');
  const b = await req.json().catch(() => ({}));
  if (b.choice !== 'accepted' && b.choice !== 'refused') return fail(400, 'Choix invalide.');
  const jar = await cookies();
  jar.set(CONSENT_COOKIE, b.choice, { httpOnly: false, sameSite: 'lax', secure: isProd(), path: '/', maxAge: CONSENT_DAYS * 24 * 3600 });
  if (b.choice === 'refused') jar.delete(VISITOR_COOKIE);
  return json({ choice: b.choice });
}
