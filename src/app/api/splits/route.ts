import { route } from '@/lib/server/route';
import { listSplitInvites } from '@/lib/server/commerce';

/** Collaborations proposées à l'utilisateur connecté. */
export const GET = route(({ user }) => listSplitInvites(user.id));
