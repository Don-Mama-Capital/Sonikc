import { NextResponse } from 'next/server';
import { emailEvent } from '@/lib/server/email-events';
import { env } from '@/lib/server/env';

/** Clic dans un email : compté une fois, puis redirection vers le lien personnel du destinataire. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const r = await emailEvent((await params).token, 'click').catch(() => ({ ok: false as const }));
  const base = env().APP_URL.replace(/\/$/, '');
  return NextResponse.redirect(`${base}${r.ok && r.sharePath ? r.sharePath : '/'}`, 302);
}
