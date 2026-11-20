import { route } from '@/lib/server/route';
import { listSales } from '@/lib/server/commerce';

export const GET = route(({ user }) => listSales(user.id));
