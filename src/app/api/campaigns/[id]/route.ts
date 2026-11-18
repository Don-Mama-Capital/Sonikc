import { body, route } from '@/lib/server/route';
import { campaignDetail, cancelCampaign, cancelFollowup } from '@/lib/server/campaigns';
import { Invalid } from '@/lib/server/library';

type P = { id: string };
export const GET = route<P>(async ({ user, params }) => campaignDetail(user.id, params.id));
export const PATCH = route<P>(async ({ req, user, params }) => {
  const { action } = await body(req);
  if (action === 'cancel') return cancelCampaign(user.id, params.id);
  if (action === 'cancel_followup') return cancelFollowup(user.id, params.id);
  throw new Invalid('Action inconnue.');
});
