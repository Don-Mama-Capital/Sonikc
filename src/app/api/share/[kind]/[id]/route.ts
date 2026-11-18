import { body, route } from '@/lib/server/route';
import { getShareSettings, kindSchema, updateShareSettings } from '@/lib/server/sharing';

type P = { kind: string; id: string };
export const GET = route<P>(async ({ user, params }) => getShareSettings(user.id, kindSchema.parse(params.kind), params.id));
export const PATCH = route<P>(async ({ req, user, params }) => updateShareSettings(user.id, kindSchema.parse(params.kind), params.id, await body(req)));
