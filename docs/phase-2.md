# Phase 2 — Partage, suivi des écoutes, stats : critères

Écrits le 18 novembre 2026, avant le code. Ils ne changent pas en cours de lot. Un lot est fini quand tous ses critères bloquants sont au vert avec leur preuve ; il est alors gelé. Lots à risque (2.1 accès, 2.2 suivi) : relecture de sécurité indépendante avant la PR.

## Règles d'accès retenues (précisions de la spec)

| Niveau | Qui peut écouter |
| --- | --- |
| Privé (par défaut) | Le propriétaire seul. Tout lien renvoie « introuvable » (404), même s'il a existé |
| Sur invitation | Le propriétaire et les comptes invités : la personne doit se connecter avec l'adresse invitée |
| Public | Toute personne qui a un lien de partage ; mot de passe possible |
| En vente | Comme Public en phase 2 ; l'achat arrive en phase 4 |

- Un lien de partage vise un projet ou un morceau. Il porte un nom de source (« Instagram », « DM label X ») qui sert aux stats. Il peut être révoqué : il devient introuvable à la requête suivante.
- Dans un projet partagé, chaque morceau garde son propre réglage : un morceau privé n'y apparaît pas ; un morceau « sur invitation » n'apparaît qu'aux invités ; un morceau protégé par son propre mot de passe n'apparaît pas (il se partage seul).
- Le lien ne contient aucun secret stocké : c'est l'identifiant du lien signé par le serveur ; il peut être recopié à tout moment par le propriétaire.
- Les fichiers audio partagés passent par une adresse liée au lien, signée et à durée limitée : on n'y accède qu'avec un lien valide, jamais avec l'adresse d'un fichier.
- Le téléchargement est désactivé par défaut ; le propriétaire peut l'autoriser par projet ou par morceau.

## Lot 2.0 — Connexion avec Google

| # | Critère bloquant | Preuve |
| --- | --- | --- |
| 1 | « Continuer avec Google » ouvre une session ; premier passage = compte créé puis onboarding | Test d'intégration + parcours Chrome contre un faux serveur Google |
| 2 | Même adresse que celle d'un compte existant (email vérifié par Google) = même compte, pas de doublon | Test |
| 3 | Protections : état (`state`) et PKCE vérifiés, jeton d'identité vérifié (signature, émetteur, audience, expiration, nonce) ; email non vérifié refusé | Tests, un par protection |
| 4 | Sans identifiants Google configurés, le bouton n'apparaît pas et la route répond 404 | Test |

## Lot 2.1 — Accès

| # | Critère bloquant | Preuve |
| --- | --- | --- |
| 1 | Privé = 404 pour tout tiers (anonyme, autre compte, ancien lien) ; contrôlé par la base (RLS), pas seulement par le code | Test RLS |
| 2 | Sur invitation : sans connexion → invitation à se connecter ; connecté avec une autre adresse → refusé ; adresse invitée → accès | Tests + parcours Chrome |
| 3 | Lien révoqué ou invitation retirée = inaccessible à la requête suivante (page et audio) | Test |
| 4 | Un morceau privé dans un projet partagé reste fermé (absent de la page, audio refusé même en devinant son identifiant) | Test |
| 5 | Mot de passe : sans lui, rien n'est lisible ; changé = déverrouillages précédents annulés ; essais limités | Tests |
| 6 | Adresse audio expirée ou falsifiée = refusée ; version non courante jamais servie à un tiers | Test |
| 7 | Page d'écoute utilisable à 375 px, sans défilement horizontal ; accessibilité Lighthouse ≥ 90 | Parcours Chrome + rapport |

## Lot 2.2 — Suivi d'écoute

| # | Critère bloquant | Preuve |
| --- | --- | --- |
| 1 | Durée écoutée mesurée à ± 5 s près ; une durée annoncée plus longue que le temps réellement écoulé est plafonnée | Test simulé + parcours Chrome réel |
| 2 | Rechargement de la page = pas de double comptage (même visiteur, même morceau, même lien, moins de 30 min) | Test |
| 3 | Écoutes du propriétaire non enregistrées | Test |
| 4 | Mention visible sur la page d'écoute : le propriétaire voit les écoutes de ce lien | Capture |
| 5 | Source (nom du lien) et auditeur connu (compte connecté ou invité) enregistrés ; visiteur anonyme = identifiant aléatoire, sans donnée personnelle | Test |
| 6 | Interactions enregistrées : téléchargement (si autorisé), favori (compte connecté) | Test |

À valider en fin de phase : « enregistrer dans sa bibliothèque » et « achat » ne sont pas dans ce lot (achat = phase 4).

## Lot 2.3 — Stats et notifications

| # | Critère bloquant | Preuve |
| --- | --- | --- |
| 1 | Par morceau : écoutes, auditeurs uniques, temps total et moyen, écoutes complètes (≥ 80 %), détail par source ; les chiffres affichés = ceux de la base | Test |
| 2 | Entonnoir par lien : ouvertures → lectures → plus de 30 s → écoute complète → téléchargement | Test |
| 3 | Notification dans l'app en moins de 10 s après le début d'une écoute | Parcours Chrome (deux navigateurs) |
| 4 | Liste des écoutes récentes : qui (nom du compte ou « anonyme »), source, date, durée | Test + capture |
