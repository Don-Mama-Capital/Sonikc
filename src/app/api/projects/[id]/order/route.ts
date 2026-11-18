import { body, route } from '@/lib/server/route';
import { reorderProject } from '@/lib/server/library';

export const PUT = route<{ id: string }>(async ({ req, user, params }) =>
  reorderProject(user.id, params.id, ((await body(req)).trackIds as string[]) ?? []));
