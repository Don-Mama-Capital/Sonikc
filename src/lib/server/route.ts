import { Invalid } from './library';
import type { NextResponse } from 'next/server';
import type { SessionUser } from './auth';
import { apiUser, fail, json, sameOrigin } from './http';
import { handleError } from './errors';

type Ctx<P> = { params: Promise<P> };

/**
 * Enveloppe commune des routes API : session et profil exigés, origine vérifiée pour
 * les écritures, erreurs métier traduites. Le handler rend des données sérialisées en JSON.
 */
export function route<P = Record<string, string>>(
  handler: (args: { req: Request; user: SessionUser; params: P }) => Promise<unknown>,
) {
  return async (req: Request, ctx: Ctx<P>): Promise<Response | NextResponse> => {
    if (req.method !== 'GET' && !sameOrigin(req)) return fail(403, 'Origine refusée.');
    const user = await apiUser();
    if (user instanceof Response) return user;
    try {
      const data = await handler({ req, user, params: ctx?.params ? await ctx.params : ({} as P) });
      return json(data ?? { ok: true });
    } catch (e) {
      return handleError(e);
    }
  };
}

const MAX_BODY = 6_000_000; // un import CSV de 5 Mo au plus, plus l'enveloppe JSON
export const body = async (req: Request) => {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) throw new Invalid('Données trop volumineuses (6 Mo au plus).');
  const text = await req.text();
  if (text.length > MAX_BODY) throw new Invalid('Données trop volumineuses (6 Mo au plus).');
  try { return JSON.parse(text || '{}') as Record<string, unknown>; } catch { return {}; }
};
