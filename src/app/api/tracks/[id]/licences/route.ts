import { route } from '@/lib/server/route';
import { trackLicenceSettings } from '@/lib/server/storefront';

export const GET = route<{ id: string }>(({ user, params }) => trackLicenceSettings(user.id, params.id));
