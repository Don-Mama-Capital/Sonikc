import { body, route } from '@/lib/server/route';
import { deleteFolder, updateFolder } from '@/lib/server/library';

export const PATCH = route<{ id: string }>(async ({ req, user, params }) => {
  const b = await body(req);
  await updateFolder(user.id, params.id, {
    name: b.name === undefined ? undefined : String(b.name),
    parentId: b.parentId === undefined ? undefined : ((b.parentId as string) || null),
  });
});
export const DELETE = route<{ id: string }>(async ({ user, params }) => deleteFolder(user.id, params.id));
