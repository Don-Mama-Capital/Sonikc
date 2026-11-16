import { route } from '@/lib/server/route';
import { listTrash } from '@/lib/server/library';

export const GET = route(async ({ user }) => listTrash(user.id));
