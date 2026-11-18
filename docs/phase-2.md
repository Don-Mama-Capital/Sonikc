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

## Résultats

### Lot 2.0 — itération 1 : 4/4 au vert, lot gelé

| # | Preuve |
| --- | --- |
| 1 | `tests/unit/google.test.ts` (parcours complet contre le faux Google) ; `tests/e2e/google.spec.ts` : bouton → compte Google → profil → bibliothèque, puis reconnexion directe |
| 2 | Test « même adresse qu'un compte existant » : un seul compte, liaison au premier passage, majuscules ignorées |
| 3 | Un test par protection : state falsifié, absent ou d'une autre tentative ; tentative de plus de 10 min ; code volé rejoué sans le vérificateur PKCE ; signature d'une autre clé ; émetteur, audience, expiration, nonce ; algorithme « none » ; email non vérifié (aussi dans Chrome). En plus : adresse déjà liée à un autre compte Google refusée |
| 4 | Test : sans identifiants, `googleConfig()` vide et la route répond 404 ; le bouton n'est rendu que si la configuration existe |

### Lot 2.1 — itération 1 : 7/7 au vert, lot gelé (relecture indépendante en fin de phase)

| # | Preuve |
| --- | --- |
| 1 | `tests/unit/sharing.test.ts` : privé → introuvable pour anonyme, autre compte et ancien lien ; requêtes directes sur projets, morceaux, versions et liaisons au nom d'un tiers avec un lien valide → vide (RLS) |
| 2 | Test + `tests/e2e/share.spec.ts` : lien d'invitation reçu par email, connexion exigée, autre adresse refusée, adresse invitée (casse ignorée) admise sans profil de producteur |
| 3 | Test : lien révoqué et invitation retirée → introuvable/refusé à la requête suivante, audio compris ; Chrome : page et audio en 404 après révocation |
| 4 | Test : morceau privé absent et son audio refusé même avec son identifiant ; morceau protégé par son propre mot de passe absent du projet |
| 5 | Test : sans mot de passe rien n'est lisible ; 5 erreurs → bloqué 15 min ; nouveau mot de passe → anciens déverrouillages annulés. Chrome : mauvais puis bon mot de passe |
| 6 | Test : adresse audio expirée, falsifiée ou d'une autre version refusée ; l'ancienne version n'est plus servie quand une nouvelle devient courante |
| 7 | Chrome à 375 px : aucun défilement horizontal, lecture qui démarre (capture `test-results/share-mobile.png`) ; Lighthouse mobile de la page partagée : accessibilité 100 (SEO 60 voulu : page non indexée) |

Précision apportée en cours de lot (sans changer les critères) : un morceau sans réglage propre « suit le projet » ; partagé seul, il reste privé. Sinon, partager un projet aurait affiché une page vide, puisque tous les morceaux sont privés par défaut.
