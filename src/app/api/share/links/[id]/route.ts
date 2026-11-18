import { route } from '@/lib/server/route';
import { revokeLink } from '@/lib/server/sharing';

export const DELETE = route<{ id: string }>(async ({ user, params }) => { await revokeLink(user.id, params.id); });
