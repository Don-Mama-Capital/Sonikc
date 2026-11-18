import { body, route } from '@/lib/server/route';
import { getTrack, trashTrack, updateTrack } from '@/lib/server/library';

export const GET = route<{ id: string }>(async ({ user, params }) => getTrack(user.id, params.id));
export const PATCH = route<{ id: string }>(async ({ req, user, params }) => updateTrack(user.id, params.id, await body(req)));
export const DELETE = route<{ id: string }>(async ({ user, params }) => trashTrack(user.id, params.id));
