import { route } from '@/lib/server/route';
import { revokeInvite } from '@/lib/server/sharing';

export const DELETE = route<{ id: string }>(async ({ user, params }) => { await revokeInvite(user.id, params.id); });
