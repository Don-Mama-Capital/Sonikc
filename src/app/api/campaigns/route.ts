import { body, route } from '@/lib/server/route';
import { createCampaign, listCampaigns } from '@/lib/server/campaigns';

export const GET = route(async ({ user }) => listCampaigns(user.id));
export const POST = route(async ({ req, user }) => createCampaign(user.id, await body(req)));
