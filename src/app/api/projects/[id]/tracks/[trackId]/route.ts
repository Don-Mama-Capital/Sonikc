import { route } from '@/lib/server/route';
import { removeFromProject } from '@/lib/server/library';

export const DELETE = route<{ id: string; trackId: string }>(async ({ user, params }) => removeFromProject(user.id, params.id, params.trackId));
