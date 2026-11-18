import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { googleCallback, googleConfig, GoogleError, OAUTH_COOKIE } from '@/lib/server/google';
import { setSessionCookie } from '@/lib/server/session';
import { env } from '@/lib/server/env';

export async function GET(req: Request) {
  if (!googleConfig()) return new NextResponse('Introuvable', { status: 404 });
  const base = env().APP_URL.replace(/\/$/, '');
  const q = new URL(req.url).searchParams;
  const jar = await cookies();
  const raw = jar.get(OAUTH_COOKIE)?.value;
  jar.delete({ name: OAUTH_COOKIE, path: '/api/auth/google' });
  try {
    const r = await googleCallback({ code: q.get('code'), state: q.get('state'), error: q.get('error') }, raw);
    await setSessionCookie(r.token);
    // Un auditeur invité n'a pas besoin de profil de producteur : il revient directement sur la page partagée.
    const dest = r.next ?? (r.needsProfile ? '/onboarding' : '/app');
    return NextResponse.redirect(`${base}${dest}`, 302);
  } catch (e) {
    if (!(e instanceof GoogleError)) console.error('google callback', e);
    const code = e instanceof GoogleError ? e.code : 'token';
    return NextResponse.redirect(`${base}/login?error=google_${code}`, 302);
  }
}
