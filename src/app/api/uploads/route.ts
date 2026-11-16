import { apiUser, json, sameOrigin, fail } from '@/lib/server/http';
import { handleError } from '@/lib/server/errors';
import { startUpload } from '@/lib/server/uploads';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail(403, 'Origine refusée.');
  const user = await apiUser();
  if (user instanceof Response) return user;
  try {
    return json(await startUpload(user.id, await req.json()));
  } catch (e) {
    return handleError(e);
  }
}
