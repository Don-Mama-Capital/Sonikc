import { body, route } from '@/lib/server/route';
import { respondSplit, withdrawSplit } from '@/lib/server/commerce';

/** Le collaborateur répond à la proposition qu'il a vue : { accept, pct, role, invitedAt }. */
export const POST = route<{ trackId: string }>(async ({ req, user, params }) => respondSplit(user.id, params.trackId, await body(req)));
/** Le collaborateur se retire de sa part. */
export const DELETE = route<{ trackId: string }>(({ user, params }) => withdrawSplit(user.id, params.trackId));
