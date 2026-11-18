import { body, route } from '@/lib/server/route';
import { setCurrentVersion } from '@/lib/server/library';

export const POST = route<{ id: string }>(async ({ req, user, params }) =>
  setCurrentVersion(user.id, params.id, String((await body(req)).versionId ?? '')));
