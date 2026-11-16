import { fail, json } from '@/lib/server/http';
import { AlreadyExists, putStream, TooLarge, verifyUploadToken } from '@/lib/server/storage';

/** Réception du fichier (pilote local). Autorisé par le jeton signé de l'URL, valable pour une seule clé. */
export async function PUT(req: Request) {
  const u = new URL(req.url);
  const key = u.searchParams.get('key') ?? '';
  const exp = Number(u.searchParams.get('exp'));
  const max = Number(u.searchParams.get('max'));
  const sig = u.searchParams.get('sig') ?? '';
  if (!verifyUploadToken(key, exp, max, sig)) return fail(403, 'Lien d’envoi expiré ou invalide.');
  if (Number(req.headers.get('content-length') ?? 0) > max) return fail(413, 'Fichier trop lourd.');
  if (!req.body) return fail(400, 'Fichier vide.');
  try {
    const { size } = await putStream(key, req.body, max);
    if (size === 0) return fail(400, 'Fichier vide.');
    return json({ ok: true, size });
  } catch (e) {
    if (e instanceof TooLarge) return fail(413, 'Fichier trop lourd.');
    // Écriture unique : un fichier déjà reçu ne peut pas être remplacé (son empreinte fait foi).
    if (e instanceof AlreadyExists) return fail(409, 'Ce fichier a déjà été reçu.');
    throw e;
  }
}
