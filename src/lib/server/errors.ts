import { ZodError } from 'zod';
import { Invalid, NotFound } from './library';
import { fail } from './http';

/** Traduit les erreurs métier en réponses HTTP lisibles ; laisse remonter le reste (500). */
export function handleError(e: unknown) {
  if (e instanceof NotFound) return fail(404, e.message);
  if (e instanceof Invalid) return fail(400, e.message);
  if (e instanceof ZodError) return fail(400, 'Données invalides.', { issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  if (e instanceof Error && e.message === 'Le paiement n’est pas encore configuré.') return fail(503, e.message);
  // Erreur renvoyée par Stripe : message générique (le détail part dans les journaux).
  if (typeof (e as { type?: unknown })?.type === 'string' && String((e as { type: string }).type).startsWith('Stripe')) {
    console.error('stripe', (e as Error).message);
    return fail(502, 'Le service de paiement ne répond pas. Réessaie dans un instant.');
  }
  throw e;
}
