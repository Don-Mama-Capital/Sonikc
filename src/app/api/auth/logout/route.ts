import { cookies } from 'next/headers';
import { revokeToken } from '@/lib/server/auth';
import { fail, json, sameOrigin } from '@/lib/server/http';
import { SESSION_COOKIE, clearSessionCookie } from '@/lib/server/session';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail(403, 'Origine refusée.');
  await revokeToken((await cookies()).get(SESSION_COOKIE)?.value);
  await clearSessionCookie();
  return json({ ok: true });
}
