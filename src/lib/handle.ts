// Règles des identifiants publics (vvault.app/handle → sonikc.app/handle).

export const HANDLE_RE = /^[a-z0-9_.]{3,30}$/;

// Mots réservés : routes de l'app et termes trompeurs.
const RESERVED = new Set([
  'admin', 'api', 'app', 'auth', 'login', 'logout', 'onboarding', 'settings', 'help', 'about', 'pricing',
  'terms', 'privacy', 'legal', 'support', 'contact', 'sonikc', 'official', 'staff', 'root', 'www', 'mail',
  'static', 'assets', 'files', 'upload', 'uploads', 'dev', 'null', 'undefined', 'browse', 'search', 'blog',
  // Pages de Sonikc à la racine (phases 2 à 5).
  'recus', 'achats', 'checkout', 'paiement', 'order', 'orders', 'commande', 'commandes', 'facture', 'invoice',
  'certificat', 'certificats', 'tarifs', 'offres', 'cgv', 'cgu', 'mentions', 'licence', 'licences', 'stripe',
]);

export function normalizeHandle(input: string) {
  return input.trim().toLowerCase().replace(/^@/, '');
}

export function handleProblem(input: string): string | null {
  const h = normalizeHandle(input);
  if (!HANDLE_RE.test(h)) return '3 à 30 caractères : lettres minuscules, chiffres, point ou tiret bas.';
  if (h.startsWith('.') || h.endsWith('.') || h.includes('..')) return 'Pas de point au début, à la fin, ni deux de suite.';
  if (RESERVED.has(h)) return 'Cet identifiant est réservé.';
  return null;
}
