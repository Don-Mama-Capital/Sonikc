import { route } from '@/lib/server/route';
import { billingOverview } from '@/lib/server/billing';

export const GET = route(({ user }) => billingOverview(user.id));
