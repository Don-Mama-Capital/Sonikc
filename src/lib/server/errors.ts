import { ZodError } from 'zod';
import { Invalid, NotFound } from './library';
import { fail } from './http';

/** Traduit les erreurs métier en réponses HTTP lisibles ; laisse remonter le reste (500). */
export function handleError(e: unknown) {
  if (e instanceof NotFound) return fail(404, e.message);
  if (e instanceof Invalid) return fail(400, e.message);
  if (e instanceof ZodError) return fail(400, 'Données invalides.', { issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  throw e;
}
