import { AuthError, verifyCode } from '@/lib/server/auth';
import { fail, json, sameOrigin } from '@/lib/server/http';
import { setSessionCookie } from '@/lib/server/session';
import { safeNext } from '@/lib/server/google';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail(403, 'Origine refusée.');
  const body = await req.json().catch(() => ({}));
  try {
    const r = await verifyCode(String(body.email ?? ''), String(body.code ?? ''));
    await setSessionCookie(r.token);
    return json({ ok: true, next: safeNext(body.next) ?? (r.needsProfile ? '/onboarding' : '/app') });
  } catch (e) {
    if (e instanceof AuthError) return fail(400, e.message, { code: e.code });
    if (e instanceof Error && e.name === 'ZodError') return fail(400, 'Adresse email invalide.');
    throw e;
  }
}
