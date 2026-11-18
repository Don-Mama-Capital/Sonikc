import { route } from '@/lib/server/route';
import { deleteGroup } from '@/lib/server/contacts';

export const DELETE = route<{ id: string }>(async ({ user, params }) => { await deleteGroup(user.id, params.id); });
