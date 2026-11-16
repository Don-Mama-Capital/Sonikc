import { body, route } from '@/lib/server/route';
import { createProject } from '@/lib/server/library';

export const POST = route(async ({ req, user }) => {
  const b = await body(req);
  return createProject(user.id, { title: String(b.title ?? ''), folderId: (b.folderId as string) || null });
});
