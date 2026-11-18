import { body, route } from '@/lib/server/route';
import { renameVersion } from '@/lib/server/library';

export const PATCH = route<{ id: string }>(async ({ req, user, params }) =>
  renameVersion(user.id, params.id, String((await body(req)).label ?? '')));
