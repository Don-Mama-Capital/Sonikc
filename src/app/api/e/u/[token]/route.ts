import { NextResponse } from 'next/server';
import { emailEvent } from '@/lib/server/email-events';
import { env } from '@/lib/server/env';

/**
 * Désinscription. POST = en un clic (bouton de la page, ou en-tête List-Unsubscribe-Post des messageries,
 * qui ne viennent pas de notre site : pas de contrôle d'origine, le jeton signé suffit).
 * GET renvoie vers la page de confirmation : un robot qui suit les liens ne désinscrit personne.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await emailEvent(token, 'unsubscribe').catch(() => ({ ok: false as const }));
  if (!r.ok) return new NextResponse('Lien invalide.', { status: 404 });
  if ((req.headers.get('accept') ?? '').includes('text/html')) {
    return NextResponse.redirect(`${env().APP_URL.replace(/\/$/, '')}/e/u/${token}?ok=1`, 303);
  }
  return new NextResponse('Désinscription prise en compte.', { status: 200 });
}

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  return NextResponse.redirect(`${env().APP_URL.replace(/\/$/, '')}/e/u/${(await params).token}`, 302);
}
