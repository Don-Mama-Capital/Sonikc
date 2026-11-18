import { body, route } from '@/lib/server/route';
import { createFolder, listAllFolders } from '@/lib/server/library';

export const GET = route(async ({ user }) => listAllFolders(user.id));
export const POST = route(async ({ req, user }) => {
  const b = await body(req);
  return createFolder(user.id, { name: String(b.name ?? ''), parentId: (b.parentId as string) || null });
});
