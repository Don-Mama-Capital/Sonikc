import { body, route } from '@/lib/server/route';
import { publicProfileSettings, updatePublicProfile } from '@/lib/server/storefront';

export const GET = route(({ user }) => publicProfileSettings(user.id));
export const PUT = route(async ({ req, user }) => updatePublicProfile(user.id, await body(req)));
