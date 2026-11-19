import { body, route } from '@/lib/server/route';
import { listSplits, setSplits } from '@/lib/server/commerce';

export const GET = route<{ id: string }>(({ user, params }) => listSplits(user.id, params.id));
export const PUT = route<{ id: string }>(async ({ req, user, params }) => setSplits(user.id, params.id, (await body(req)).splits));
