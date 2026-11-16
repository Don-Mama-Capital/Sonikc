import { AuthError, requestCode } from '@/lib/server/auth';
import { fail, json, sameOrigin } from '@/lib/server/http';
import { clientIp } from '@/lib/server/session';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail(403, 'Origine refusée.');
  const body = await req.json().catch(() => ({}));
  try {
    await requestCode(String(body.email ?? ''), await clientIp());
    return json({ ok: true });
  } catch (e) {
    if (e instanceof AuthError) return fail(e.code === 'rate_limited' ? 429 : 400, e.message, { code: e.code });
    throw e;
  }
}
