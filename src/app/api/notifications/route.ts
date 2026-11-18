import { route } from '@/lib/server/route';
import { notifications } from '@/lib/server/listening';

export const GET = route(async ({ user }) => notifications(user.id));
