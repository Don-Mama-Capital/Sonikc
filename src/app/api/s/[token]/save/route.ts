import { fail, json, sameOrigin } from '@/lib/server/http';
import { resolveFromCookies } from '@/lib/server/listener-http';
import { saveLink, unsaveLink } from '@/lib/server/saves';

/** Enregistrer (ou retirer) le partage dans « Reçus ». */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!sameOrigin(req)) return fail(403, 'Origine refusée.');
  const { user, resolution: r } = await resolveFromCookies((await params).token);
  if (!user) return fail(401, 'Connecte-toi pour enregistrer ce partage.');
  const b = await req.json().catch(() => ({}));
  if (!b.on) {
    if (r.status === 'ok') await unsaveLink(user.id, r.meta.linkId);
    return json({ saved: false });
  }
  if (r.status !== 'ok') return fail(404, 'Introuvable.');
  try {
    return json({ saved: await saveLink(r.ctx) });
  } catch (e) {
    if (String((e as Error).message).includes('too many saves')) return fail(400, 'Limite atteinte : 200 partages enregistrés. Retire ceux qui ne servent plus.');
    return fail(404, 'Introuvable.');
  }
}
