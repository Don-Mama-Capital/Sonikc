import { body, route } from '@/lib/server/route';
import { setGroupMembers } from '@/lib/server/contacts';

export const POST = route<{ id: string }>(async ({ req, user, params }) => {
  const b = await body(req);
  await setGroupMembers(user.id, params.id, b.contactIds, b.add !== false);
});
