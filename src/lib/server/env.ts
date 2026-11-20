import { z } from 'zod';

const schema = z
  .object({
    DATABASE_URL: z.string().min(1),
    APP_SECRET: z.string().min(32, 'APP_SECRET doit faire au moins 32 caractères'),
    APP_URL: z.string().url().default('http://localhost:3000'),
    STORAGE_DRIVER: z.enum(['local', 'supabase']).default('local'),
    STORAGE_DIR: z.string().default('.data/storage'),
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_SECRET_KEY: z.string().min(20).optional(),
    SUPABASE_BUCKET: z.string().default('audio'),
    MAIL_DRIVER: z.enum(['local', 'resend']).default('local'),
    MAIL_DIR: z.string().default('.data/mail'),
    RESEND_API_KEY: z.string().optional(),
    MAIL_FROM: z.string().default('Sonikc <onboarding@resend.dev>'),
    ALLOW_LOCAL_DRIVERS: z.string().optional(),
    // Paiement : clé de test uniquement (sk_test_…) tant que la vente réelle n'est pas validée.
    STRIPE_SECRET_KEY: z.string().regex(/^(sk|rk)_test_/, 'STRIPE_SECRET_KEY doit être une clé de test (sk_test_…)').optional(),
    STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_').optional(),
    STRIPE_API_BASE: z.string().url().optional(), // faux Stripe des tests
    STRIPE_CONNECT_COUNTRY: z.string().regex(/^[A-Z]{2}$/).default('FR'),
    NODE_ENV: z.string().default('development'),
  })
  .superRefine((e, ctx) => {
    if (e.STORAGE_DRIVER === 'supabase' && (!e.SUPABASE_URL || !e.SUPABASE_SECRET_KEY)) {
      ctx.addIssue({ code: 'custom', message: 'STORAGE_DRIVER=supabase exige SUPABASE_URL et SUPABASE_SECRET_KEY' });
    }
    if (e.MAIL_DRIVER === 'resend' && !e.RESEND_API_KEY) {
      ctx.addIssue({ code: 'custom', message: 'MAIL_DRIVER=resend exige RESEND_API_KEY' });
    }
    // En production, les pilotes locaux sont refusés (sauf recette explicite) : un code de connexion
    // écrit sur le disque d'un serveur, c'est un utilisateur qui ne reçoit jamais son email.
    if (e.NODE_ENV === 'production' && !e.ALLOW_LOCAL_DRIVERS && (e.MAIL_DRIVER === 'local' || e.STORAGE_DRIVER === 'local')) {
      ctx.addIssue({ code: 'custom', message: 'En production, configure MAIL_DRIVER=resend et STORAGE_DRIVER=supabase' });
    }
  });

export type Env = z.infer<typeof schema>;

let cached: { raw: string; env: Env } | null = null;

/** Configuration validée. Échoue tôt et clairement si une variable manque. */
export function env(): Env {
  const raw = JSON.stringify([
    process.env.DATABASE_URL, process.env.STORAGE_DRIVER, process.env.STORAGE_DIR, process.env.MAIL_DRIVER, process.env.MAIL_DIR,
    process.env.SUPABASE_URL, process.env.RESEND_API_KEY, process.env.NODE_ENV, process.env.ALLOW_LOCAL_DRIVERS,
    process.env.STRIPE_SECRET_KEY, process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_API_BASE,
  ]);
  if (!cached || cached.raw !== raw) cached = { raw, env: schema.parse(process.env) };
  return cached.env;
}

export const isProd = () => env().NODE_ENV === 'production';
