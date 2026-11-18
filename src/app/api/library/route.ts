import { route } from '@/lib/server/route';
import { browse } from '@/lib/server/library';

export const GET = route(async ({ req, user }) => {
  const sp = Object.fromEntries(new URL(req.url).searchParams);
  return browse(user.id, { ...sp, folderId: sp.folderId || null });
});
