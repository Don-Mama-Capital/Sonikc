import { body, route } from '@/lib/server/route';
import { addToProject } from '@/lib/server/library';

export const POST = route<{ id: string }>(async ({ req, user, params }) =>
  addToProject(user.id, params.id, ((await body(req)).trackIds as string[]) ?? []));
