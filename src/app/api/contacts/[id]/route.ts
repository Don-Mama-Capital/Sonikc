import { body, route } from '@/lib/server/route';
import { contactDetail, deleteContact, updateContact } from '@/lib/server/contacts';

type P = { id: string };
export const GET = route<P>(async ({ user, params }) => contactDetail(user.id, params.id));
export const PATCH = route<P>(async ({ req, user, params }) => { await updateContact(user.id, params.id, await body(req)); });
export const DELETE = route<P>(async ({ user, params }) => { await deleteContact(user.id, params.id); });
