import { body, route } from '@/lib/server/route';
import { invite, kindSchema } from '@/lib/server/sharing';

export const POST = route<{ kind: string; id: string }>(async ({ req, user, params }) =>
  invite(user.id, kindSchema.parse(params.kind), params.id, (await body(req)).email, user.displayName ?? user.handle ?? 'Un producteur'));
