import postgres from 'postgres';
import { env } from './env';

type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

const globalForDb = globalThis as unknown as { __sonikcSql?: Sql };

/** Connexion partagée (une seule par processus, survit au rechargement à chaud en dev). */
export function sql(): Sql {
  if (!globalForDb.__sonikcSql) {
    globalForDb.__sonikcSql = postgres(env().DATABASE_URL, {
      max: 10,
      idle_timeout: 20,
      onnotice: () => {},
    });
  }
  return globalForDb.__sonikcSql;
}

/**
 * Exécute `fn` dans une transaction au nom d'un utilisateur : rôle `sonikc_app`
 * et identifiant posé pour les politiques RLS. Toute donnée lue ou écrite ici
 * est filtrée par la base, quoi que fasse le code appelant.
 */
export async function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('invalid user id');
  return sql().begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    await tx`set local role sonikc_app`;
    return fn(tx);
  }) as Promise<T>;
}

/** Accès « service » sans RLS : réservé à l'authentification et au worker. */
export async function asService<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql().begin(fn) as Promise<T>;
}
