import { body, route } from '@/lib/server/route';
import { setTrackLicence } from '@/lib/server/storefront';

export const PUT = route<{ id: string; templateId: string }>(async ({ req, user, params }) => setTrackLicence(user.id, params.id, params.templateId, await body(req)));
