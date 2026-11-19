import { route } from '@/lib/server/route';
import { refundBySeller } from '@/lib/server/commerce';

export const POST = route<{ id: string }>(({ user, params }) => refundBySeller(user.id, params.id));
