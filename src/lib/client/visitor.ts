/**
 * Identifiant de visiteur gardé en mémoire le temps de la page (rien n'est écrit sur l'appareil).
 * Utilisé pour la mesure d'écoute quand le visiteur n'a pas accepté le cookie de mesure.
 */
export const PAGE_VISITOR: string = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : '';
