import { body, route } from '@/lib/server/route';
import { createContact, listContacts } from '@/lib/server/contacts';

export const GET = route(async ({ req, user }) => {
  const q = new URL(req.url).searchParams;
  return listContacts(user.id, { q: q.get('q') ?? undefined, tag: q.get('tag') ?? undefined, groupId: q.get('group') ?? undefined, offset: Number(q.get('offset') ?? 0) });
});
export const POST = route(async ({ req, user }) => createContact(user.id, await body(req)));
