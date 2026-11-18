import { body, route } from '@/lib/server/route';
import { createGroup, listGroups } from '@/lib/server/contacts';

export const GET = route(async ({ user }) => listGroups(user.id));
export const POST = route(async ({ req, user }) => createGroup(user.id, await body(req)));
