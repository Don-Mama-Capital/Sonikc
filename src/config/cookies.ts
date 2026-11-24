/**
 * Liste unique des cookies de Sonikc : bandeau, page Cookies et test réseau en découlent.
 * Seul le cookie de mesure demande ton accord ; les autres sont indispensables au service demandé.
 */
export const CONSENT_COOKIE = 'sk_consent';
export const CONSENT_DAYS = 180; // le choix est redemandé au bout de 6 mois

export const COOKIES = [
  { name: 'sk_session', purpose: 'Te garder connecté à ton compte.', duration: '30 jours', needsConsent: false },
  { name: 'sk_oauth', purpose: 'Sécuriser la connexion avec Google (le temps de la connexion).', duration: '10 minutes', needsConsent: false },
  { name: 'sk_unlock_…', purpose: 'Se souvenir qu’un partage protégé a été déverrouillé avec son mot de passe.', duration: '7 jours', needsConsent: false },
  { name: CONSENT_COOKIE, purpose: 'Se souvenir de ton choix sur les cookies.', duration: '6 mois', needsConsent: false },
  { name: 'sk_vid', purpose: 'Mesure d’écoute : identifiant au hasard qui évite de te compter deux fois quand tu réécoutes un partage et permet au producteur de compter ses auditeurs uniques.', duration: '1 an', needsConsent: true },
] as const;
