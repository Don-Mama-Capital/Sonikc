import { apiUser, fail, json, sameOrigin } from '@/lib/server/http';
import { handleError } from '@/lib/server/errors';
import { completeUpload } from '@/lib/server/uploads';

export async function POST(req: Request, ctx: { params: Promise<{ kind: string; id: string }> }) {
  if (!sameOrigin(req)) return fail(403, 'Origine refusée.');
  const user = await apiUser();
  if (user instanceof Response) return user;
  const { kind, id } = await ctx.params;
  if (kind !== 'version' && kind !== 'import') return fail(404, 'Introuvable.');
  try {
    return json(await completeUpload(user.id, kind, id));
  } catch (e) {
    return handleError(e);
  }
}
