import { route } from '@/lib/server/route';
import { markNotificationsRead } from '@/lib/server/listening';

export const POST = route(async ({ user }) => { await markNotificationsRead(user.id); });
