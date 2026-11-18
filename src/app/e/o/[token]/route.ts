import { emailEvent } from '@/lib/server/email-events';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** Pixel d'ouverture (indicatif : certaines messageries le chargent d'office). */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  await emailEvent((await params).token, 'open').catch(() => null);
  return new Response(GIF, { headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, private' } });
}
