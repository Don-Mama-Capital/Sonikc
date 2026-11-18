import { body, route } from '@/lib/server/route';
import { getProject, trashProject, updateProject } from '@/lib/server/library';

export const GET = route<{ id: string }>(async ({ user, params }) => getProject(user.id, params.id));
export const PATCH = route<{ id: string }>(async ({ req, user, params }) => {
  const b = await body(req);
  await updateProject(user.id, params.id, {
    title: b.title === undefined ? undefined : String(b.title),
    pinned: typeof b.pinned === 'boolean' ? b.pinned : undefined,
    folderId: b.folderId === undefined ? undefined : ((b.folderId as string) || null),
  });
});
export const DELETE = route<{ id: string }>(async ({ user, params }) => trashProject(user.id, params.id));
