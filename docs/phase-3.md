# Phase 3 — Contacts, emailing, programmation : critères

Écrits le 19 novembre 2026, avant le code. Un lot est fini quand tous ses critères bloquants sont au vert avec leur preuve, puis gelé. Lot à risque (3.2 : envoi d'emails au nom du producteur, liens personnels, suivi) : relecture indépendante avant la PR.

## Choix retenus (versions les plus efficaces)

- **Un contact est relié à ses écoutes automatiquement** : par son lien personnel (reçu par email), ou s'il se connecte avec la même adresse. Aucune saisie manuelle.
- **Score d'activité calculé à la lecture** sur les 90 derniers jours (écoute > 30 s : 1 point, écoute complète : 3, téléchargement ou enregistrement dans « Reçus » : 5, clic dans un email : 1). Toujours juste, rien à recalculer.
- **Groupes à règle évalués à la lecture** (« a écouté plus de 60 s », « tag », « score au moins N », « inactif depuis N jours ») : ils se mettent à jour seuls, sans tâche de fond. Groupes manuels possibles aussi.
- **Import CSV tolérant** : séparateur `,` ou `;`, en-têtes français ou anglais, doublons fusionnés (adresse sans tenir compte de la casse ; noms et tags réunis), y compris avec les contacts existants.
- **Emailing** : chaque destinataire reçoit son **propre lien de partage** (son écoute arrive avec son nom), un lien de désinscription en un clic (et l'en-tête standard des messageries), et la réponse arrive directement dans la boîte du producteur (Reply-To).
- **Envoi par le worker, à débit maîtrisé** : plafond quotidien réglable (100 par défaut = offre gratuite de Resend) ; le reste part le lendemain, sans rien perdre.
- **Relances** : elles ne partent pas à ceux qui ont déjà écouté, cliqué, répondu (marqué en un clic par le producteur) ou se sont désinscrits.
- Les ouvertures d'email sont indicatives (certaines messageries les simulent) : les décisions s'appuient sur les écoutes et les clics.

## Lot 3.1 — Contacts

| # | Critère bloquant | Preuve |
| --- | --- | --- |
| 1 | Import CSV de 500 lignes avec doublons fusionnés (aussi avec les contacts déjà présents) ; lignes invalides signalées sans bloquer l'import | Test |
| 2 | Un groupe à règle se met à jour seul après une écoute | Test |
| 3 | Score d'activité et dernière activité exacts par rapport aux écoutes, téléchargements, enregistrements et clics | Test |
| 4 | Un compte ne voit et ne modifie que ses propres contacts et groupes (RLS) | Test |
| 5 | Page Contacts : recherche, tags, groupes, import, fiche avec historique ; utilisable à 375 px | Parcours Chrome |

## Lot 3.2 — Emailing

| # | Critère bloquant | Preuve |
| --- | --- | --- |
| 1 | Chaque destinataire a son propre lien et son écoute arrive avec son nom | Test |
| 2 | Désinscription en un clic respectée (lien et en-tête List-Unsubscribe) : plus aucun envoi à cette adresse pour ce producteur | Test |
| 3 | Plafond quotidien respecté, le reste part le jour suivant ; un envoi en échec est réessayé puis marqué en erreur, sans doublon | Test |
| 4 | Ouvertures et clics enregistrés (une fois par destinataire) ; le clic mène au partage | Test |
| 5 | Un partage privé ne peut pas être envoyé ; un partage sur invitation crée l'invitation de chaque destinataire | Test |
| 6 | Parcours complet dans Chrome : composer, envoyer, email reçu, écoute du destinataire visible avec son nom | Parcours Chrome |

## Lot 3.3 — Programmation et relances

| # | Critère bloquant | Preuve |
| --- | --- | --- |
| 1 | Un envoi programmé part à l'heure, à 1 min près | Test |
| 2 | Une relance ne part pas si le contact a déjà écouté, cliqué, répondu ou s'est désinscrit | Test |
| 3 | Programmation et relance annulables tant qu'elles ne sont pas parties | Test |
