import { body, route } from '@/lib/server/route';
import { listTemplates, saveTemplate } from '@/lib/server/storefront';

export const GET = route(({ user }) => listTemplates(user.id));
export const POST = route(async ({ req, user }) => saveTemplate(user.id, null, await body(req)));
