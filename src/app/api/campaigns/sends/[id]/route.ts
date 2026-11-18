import { body, route } from '@/lib/server/route';
import { markReplied } from '@/lib/server/campaigns';

export const PATCH = route<{ id: string }>(async ({ req, user, params }) => { await markReplied(user.id, params.id, (await body(req)).replied); });
