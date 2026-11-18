import { body, route } from '@/lib/server/route';
import { importContacts } from '@/lib/server/contacts';

export const POST = route(async ({ req, user }) => { const b = await body(req); return importContacts(user.id, b.csv, b.tags); });
