import { route } from '@/lib/server/route';
import { restoreTrack } from '@/lib/server/library';

export const POST = route<{ id: string }>(async ({ user, params }) => restoreTrack(user.id, params.id));
