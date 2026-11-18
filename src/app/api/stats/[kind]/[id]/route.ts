import { route } from '@/lib/server/route';
import { kindSchema } from '@/lib/server/sharing';
import { linkFunnel, trackStats } from '@/lib/server/listening';

export const GET = route<{ kind: string; id: string }>(async ({ user, params }) => {
  const kind = kindSchema.parse(params.kind);
  return {
    track: kind === 'track' ? await trackStats(user.id, params.id) : null,
    funnel: await linkFunnel(user.id, kind, params.id),
  };
});
