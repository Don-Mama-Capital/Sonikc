import { body, route } from '@/lib/server/route';
import { createLink, kindSchema } from '@/lib/server/sharing';

export const POST = route<{ kind: string; id: string }>(async ({ req, user, params }) =>
  createLink(user.id, kindSchema.parse(params.kind), params.id, (await body(req)).label));
