import { body, route } from '@/lib/server/route';
import { deleteTemplate, saveTemplate } from '@/lib/server/storefront';

export const PUT = route<{ id: string }>(async ({ req, user, params }) => saveTemplate(user.id, params.id, await body(req)));
export const DELETE = route<{ id: string }>(({ user, params }) => deleteTemplate(user.id, params.id));
