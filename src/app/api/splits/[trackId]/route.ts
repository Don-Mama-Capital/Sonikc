import { body, route } from '@/lib/server/route';
import { respondSplit } from '@/lib/server/commerce';

/** Le collaborateur accepte ({ accept: true }) ou refuse ({ accept: false }) sa part. */
export const POST = route<{ trackId: string }>(async ({ req, user, params }) => respondSplit(user.id, params.trackId, (await body(req)).accept));
