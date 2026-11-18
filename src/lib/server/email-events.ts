import { asApp } from './db';
import { parseSendToken } from './email-token';
import { linkToken } from './share-token';

/** Ouverture, clic, désinscription depuis un email : jeton signé vérifié, puis fonction de la base (rôle de l'app). */
export async function emailEvent(token: string, kind: 'open' | 'click' | 'unsubscribe') {
  const sendId = parseSendToken(token);
  if (!sendId) return { ok: false as const };
  const [r] = await asApp((tx) => tx<{ link: string | null }[]>`select app.email_event(${sendId}, ${kind}) as link`);
  return { ok: true as const, sharePath: r?.link ? `/s/${linkToken(r.link)}` : null };
}
