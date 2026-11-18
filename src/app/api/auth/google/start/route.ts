import { NextResponse } from 'next/server';
import { googleConfig, googleStart, OAUTH_COOKIE } from '@/lib/server/google';
import { isProd } from '@/lib/server/env';

export async function GET(req: Request) {
  if (!googleConfig()) return new NextResponse('Introuvable', { status: 404 });
  const { url, cookie, maxAge } = googleStart(new URL(req.url).searchParams.get('next'));
  const res = NextResponse.redirect(url, 302);
  res.cookies.set(OAUTH_COOKIE, cookie, { httpOnly: true, sameSite: 'lax', secure: isProd(), path: '/api/auth/google', maxAge });
  return res;
}
