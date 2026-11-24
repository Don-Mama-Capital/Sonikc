import { cookies } from 'next/headers';
import { fail, json, sameOrigin } from '@/lib/server/http';
import { visitorId } from '@/lib/server/listener-http';
import { clientIp } from '@/lib/server/session';
import { unlock } from '@/lib/server/viewer';
import { isProd } from '@/lib/server/env';

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!sameOrigin(req)) return fail(403, 'Origine refusée.');
  const { token } = await params;
  const body = await req.json().catch(() => ({}));
  const r = await unlock(token, String(body.password ?? ''), (await visitorId(true, body.pv))!, await clientIp());
  if (!r.ok) {
    if (r.error === 'not_found') return fail(404, 'Introuvable.');
    if (r.error === 'rate_limited') return fail(429, 'Trop d’essais. Réessaie dans 15 minutes.');
    return fail(400, 'Mot de passe incorrect.');
  }
  (await cookies()).set(r.cookieName, r.value, { httpOnly: true, sameSite: 'lax', secure: isProd(), path: '/', maxAge: 7 * 24 * 3600 });
  return json({ ok: true });
}
