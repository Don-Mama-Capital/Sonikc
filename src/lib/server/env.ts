import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_SECRET: z.string().min(32, 'APP_SECRET doit faire au moins 32 caractères'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  STORAGE_DRIVER: z.enum(['local']).default('local'),
  STORAGE_DIR: z.string().default('.data/storage'),
  MAIL_DRIVER: z.enum(['local']).default('local'),
  MAIL_DIR: z.string().default('.data/mail'),
  NODE_ENV: z.string().default('development'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/** Configuration validée au premier appel. Échoue tôt et clairement si une variable manque. */
export function env(): Env {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}

export const isProd = () => env().NODE_ENV === 'production';
