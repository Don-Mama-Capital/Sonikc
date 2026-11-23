import { fail } from '@/lib/server/http';
import { handleError } from '@/lib/server/errors';
import { currentUser } from '@/lib/server/session';
import { exportAccount } from '@/lib/server/account';

/** Export de toutes tes données (fichier JSON). Ouvert à tout compte, même sans profil de producteur. */
export async function GET() {
  const user = await currentUser();
  if (!user) return fail(401, 'Connexion requise.');
  try {
    const data = await exportAccount(user.id);
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="sonikc-mes-donnees-${new Date().toISOString().slice(0, 10)}.json"`,
        'cache-control': 'private, no-store',
      },
    });
  } catch (e) {
    return handleError(e);
  }
}
