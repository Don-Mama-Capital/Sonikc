# Phase 5 — Offres, abonnements, conformité (Stripe en mode test)

Critères écrits avant le code (23 novembre 2026). Un lot est fini quand tous ses critères bloquants sont au vert avec leur preuve.
Feu vert du propriétaire : « go phase 5 avec le lot 5.0 ».

## Lot 5.0 — Durcissement des paiements (ajouté le 20/11)

Le code de paiement n'utilise plus l'accès complet à la base, mais un accès dédié aux seuls droits dont il a besoin.

| # | Critère bloquant | Preuve |
| --- | --- | --- |
| 1 | Achat, webhook, livraison, virements, remboursements et invitations passent par l'accès « paiement » (`asPayments`), plus aucun `asService` dans ces modules | test (recherche dans le code) |
| 2 | Avec l'accès « paiement », lire ou modifier les bibliothèques privées, contacts, campagnes, liens, écoutes, sessions ou codes de connexion est refusé par la base | test par table |
| 3 | Les droits d'écriture sur les morceaux se limitent aux colonnes d'exclusivité | test |
| 4 | Toute la suite de la phase 4 reste au vert (achat de bout en bout, pannes simulées, test réel Stripe) | tests, recette Chrome, GitHub |

Relecture indépendante (droits d'accès, paiement).

## Lot 5.1 — Offres (fichier unique et contrôle d'accès)

| # | Critère bloquant | Preuve |
| --- | --- | --- |
| 1 | Offres, prix, limites, avantages et commission vivent dans un seul fichier (`src/config/offers.ts`) | revue du code |
| 2 | Chaque limite du fichier est appliquée côté serveur (dépassement refusé avec un message clair) | un test par limite |
| 3 | La page tarifs et le comparatif sont générés depuis le fichier : aucun texte d'offre écrit en dur ailleurs | test qui parcourt le code |
| 4 | Aucune fonction « bientôt » vendue : chaque avantage annoncé correspond à une limite ou un droit contrôlé | test |
| 5 | La commission d'une vente reste celle de l'offre au moment de la vente | test |

## Lot 5.2 — Abonnements (Stripe Billing, mode test)

| # | Critère bloquant | Preuve |
| --- | --- | --- |
| 1 | Abonnement mensuel ou annuel par Stripe Checkout ; essai gratuit une seule fois par compte | test, recette Chrome |
| 2 | Passage d'offre effectif en moins de 30 s après le webhook | test |
| 3 | Changement d'offre et résiliation depuis le portail Stripe ; webhook rejoué ou falsifié sans effet | test |
| 4 | Résiliation ou impayé : retour à l'offre gratuite, données conservées, écoute et téléchargement toujours possibles ; au-delà des limites, rien n'est supprimé, seuls les ajouts sont bloqués | test |
| 5 | Prix TTC affichés, TVA du pays de l'abonné | test |

Relecture indépendante (paiement).

## Lot 5.3 — Conformité

| # | Critère bloquant | Preuve |
| --- | --- | --- |
| 1 | Bandeau cookies : « Refuser » au même niveau que « Accepter », choix modifiable à tout moment | capture |
| 2 | Aucun traceur (cookie ou stockage non indispensable) avant consentement | test réseau dans Chrome |
| 3 | Pages légales (mentions, CGU, CGV, confidentialité, cookies) en place, chaque passage à compléter clairement signalé | capture |
| 4 | Export de toutes ses données en JSON | test |
| 5 | Suppression de compte : données et fichiers effacés ; ventes et factures gardées pour la loi, sans données personnelles inutiles | test |

Relecture indépendante (droits d'accès).

## Ajustements du 24/11 — chaque choix optimisé pour le modèle économique (demande du propriétaire)

Critères écrits avant le code. Toujours dans le périmètre des lots 5.1 à 5.3 (aucune nouvelle fonction du registre).

| # | Critère bloquant | Preuve |
| --- | --- | --- |
| A1 | Stockage plafonné pour rester rentable même à pleine utilisation : Pro 100 Go, Studio 500 Go (coût de stockage à plein < 30 % du prix HT pour Pro, < 65 % pour Studio ; usage réel bien plus bas) ; prix et commission inchangés | config + tests des limites |
| A2 | Bandeau : le texte dit ce que change l'accord pour l'auditeur et pour le producteur ; boutons toujours au même niveau | capture, test existant |
| A3 | Essai gratuit une seule fois **par personne** : empreinte (HMAC, pseudonymisée) de l'email normalisé et de l'identifiant Google gardée 3 ans, même après suppression du compte, rien d'autre ; notée aussi si le webhook n'est jamais arrivé. Hors champ, assumé : alias d'autres fournisseurs, nouvelle adresse | test (recréer un compte avec la même adresse, variantes Gmail comprises) |
| A4 | Suppression refusée tant que des parts de ventes te sont dues et ne peuvent pas t'être versées (aucun compte de reversement), sauf renonciation explicite (case « Je renonce », datée) ; le message donne le montant et les deux choix ; les parts en litige ou en remboursement ne comptent pas | test |
| A5 | Export et suppression de compte passent par un accès dédié `sonikc_account` en lecture seule sur les lignes du compte concerné ; les écritures passent par des fonctions de la base limitées au compte courant (liste des tables lue à l'appel) ; plus aucun `asService` dans le code des comptes | test des droits, test de couverture des tables + tests existants |
| A6 | La renonciation au droit de rétractation est confirmée sur support durable : email de livraison et facture | test |

Relecture indépendante (droits d'accès, paiement).
