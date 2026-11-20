# Phase 4 — Page publique, licences, paiement, certificat : critères

Écrits le 19 novembre 2026, avant le code. **Tout se fait en mode test Stripe : aucun argent réel.** La vente réelle attend la validation juridique et fiscale (onglet « Prérequis » de la spec). Lots à risque (4.3 paiement, droits) : relecture indépendante avant la PR.

## Choix retenus (versions les plus efficaces)

- **Prix fixé hors taxes par le producteur** ; l'acheteur voit le prix TTC de son pays (taux de TVA de l'UE tenus dans un seul fichier). On garde deux preuves du pays (pays déclaré et pays de la carte), comme le demande le guichet OSS. À faire valider par le comptable.
- **Paiement par Stripe Checkout** (pages de paiement de Stripe, rien à stocker côté Sonikc), **sans compte obligatoire** pour l'acheteur : il reçoit ses fichiers par email et les retrouve dans « Mes achats » s'il se connecte avec la même adresse.
- **Reversements par « paiement puis virements séparés »** (Stripe Connect) : c'est le seul montage qui gère proprement plusieurs collaborateurs sur une vente. Chaque part est versée **14 jours après le paiement**. Un remboursement avant ce délai annule simplement les virements prévus ; après, le virement est repris.
- **Commission selon l'offre du producteur**, lue dans le fichier unique des offres (créé maintenant avec la seule commission ; la phase 5 le complète). Les taux sont provisoires, à valider.
- **Exclusive réservée au début du paiement** (30 min) : deux acheteurs ne peuvent pas payer la même exclusive ; si cela arrivait malgré tout, le second est remboursé automatiquement.
- **Licence et facture en PDF**, générés par Sonikc, stockés en privé, téléchargeables par lien signé.
- **Certificat** : empreinte SHA-256 du fichier, date UTC, collaborateurs et parts figés ; il ne peut plus être modifié une fois émis.

## Lot 4.1 — Page publique

| # | Critère bloquant | Preuve |
| --- | --- | --- |
| 1 | Page `/identifiant` : profil (nom, bio, réseaux), projets et morceaux publics ou en vente ; **seul le public apparaît** (contrôlé par la base) | Test |
| 2 | Recherche et filtres BPM, tonalité, prix fonctionnels | Test |
| 3 | Identifiant réservé (`app`, `login`…) impossible ; identifiant inconnu = 404 | Test |
| 4 | Lighthouse mobile ≥ 90 (accessibilité) ; utilisable à 375 px | Rapport + parcours Chrome |

## Lot 4.2 — Licences

| # | Critère bloquant | Preuve |
| --- | --- | --- |
| 1 | Modèles de licence du producteur (formats livrés, limites, exclusivité, prix HT), proposés par défaut puis modifiables | Test |
| 2 | Libellés lisibles, aucune clé technique affichée | Test |
| 3 | Licence indisponible masquée ; exclusive vendue = morceau retiré de la vente, marqué « vendu en exclusivité » | Test |

## Lot 4.3 — Paiement (mode test)

| # | Critère bloquant | Preuve |
| --- | --- | --- |
| 1 | Achat de bout en bout : choix de licence, paiement, fichiers et PDF de licence reçus | Parcours Chrome (faux Stripe) + test réel contre Stripe en mode test sur GitHub |
| 2 | Facture émise par Sonikc, numérotée sans trou, avec la TVA du pays de l'acheteur | Test |
| 3 | Reversement = prix HT − commission de l'offre − frais Stripe, testé sur les 3 offres ; parts des collaborateurs au prorata, le centime restant au propriétaire | Test |
| 4 | Remboursement avant 14 jours : virements annulés ; après : virements repris ; commande marquée remboursée | Test |
| 5 | Webhook rejoué ou falsifié = pas de double commande, signature refusée | Test |
| 6 | Exclusive : deux paiements simultanés impossibles ; le second payé malgré tout est remboursé | Test |
| 7 | Le producteur active ses reversements (Stripe Connect) ; sans compte actif, sa part attend, rien n'est perdu | Test |

## Lot 4.4 — Certificat

| # | Critère bloquant | Preuve |
| --- | --- | --- |
| 1 | Certificat horodaté téléchargeable ; l'empreinte inscrite = l'empreinte du fichier | Test |
| 2 | Informations verrouillées : plus modifiables après émission (contrôlé par la base) | Test |

## Compte rendu (19 novembre 2026)

| Lot | Critères | Preuves |
| --- | --- | --- |
| 4.1 Page publique | 4/4 | `tests/unit/storefront.test.ts` (3), recette `storefront.spec.ts` à 375 px, Lighthouse page publique 100 / 100 / 100 / 90 |
| 4.2 Licences | 3/3 | `storefront.test.ts` (4), recette |
| 4.3 Paiement | 7/7 (faux Stripe) | `tests/unit/commerce.test.ts` (18), recette `purchase.spec.ts` ; test réel Stripe : `tests/live/stripe.test.ts`, actif avec le secret `STRIPE_TEST_SECRET_KEY` |
| 4.4 Certificat | 2/2 | `commerce.test.ts` (2), empreinte vérifiée dans la recette |

### Relecture indépendante (lots 4.3 et droits d'accès)

Aucune fuite entre comptes. 4 problèmes hauts, 9 moyens, 6 bas : tous traités et testés.

- **Hauts** : remboursement automatique, virement et reprise de virement en panne n'étaient jamais retentés ; une licence simple pouvait être payée après la vente de l'exclusive. → Remboursement demandé enregistré dans la même transaction, tâche dédiée ; parts retentées une heure plus tard avec une nouvelle clé d'idempotence, après avoir vérifié chez Stripe qu'aucun virement n'est déjà parti ; balayage toutes les 10 minutes (remboursements, virements, reprises, livraisons) ; morceau verrouillé à chaque paiement, toute licence payée après la vente de l'exclusive est remboursée.
- **Moyens** : marge d'expiration de la session (32 min), carte seulement (pas de paiement différé), événements dans le désordre et litiges (parts bloquées puis libérées ou reprises), parts calculées en entiers, limite d'essais d'exclusive par personne et par morceau, email de livraison renvoyé s'il échoue, désaccord entre pays déclaré et pays de la carte signalé, email de l'acheteur caché aux collaborateurs, pays du compte de reversement choisi par le producteur.
- **Bas** : politiques publiques limitées aux morceaux et projets visibles, remboursement déjà fait chez Stripe accepté, seules les vraies erreurs de signature refusent un webhook, fichiers livrés rangés par empreinte (jamais écrasés), plus de chaînes de tâches en double.
- **À trancher par le propriétaire** : frais Stripe perdus par Sonikc lors d'un remboursement ; un producteur peut rembourser après le virement, ce qui reprend aussi la part des collaborateurs ; un producteur peut ajouter n'importe quel identifiant comme collaborateur sans son accord.

### Choix du propriétaire (20 novembre) et seconde relecture

Consigne : le plus optimal pour Sonikc et pour les utilisateurs.

1. Paiement écrit par le serveur : gardé (la règle du fichier `CLAUDE.md` reste à mettre à jour avec l'accord explicite du propriétaire).
2. Commission : Gratuit 10 %, Pro 0 %, Studio 0 % (`src/config/offers.ts`), à confirmer avec les prix en phase 5.
3. Licences non livrables masquées : gardé ; livraison des stems au registre.
4. Frais Stripe d'un remboursement : à la charge de Sonikc pour l'instant ; à fixer dans le mandat producteurs.
5. Factures : le mode des factures suit celui de la clé Stripe ; vente réelle refusée tant qu'une mention légale manque.
6. Remboursement par le producteur jusqu'au virement seulement (ni virement en cours, ni réponse de Stripe perdue) ; ensuite par Sonikc.
7. Accord des collaborateurs (migration 0012) : invitation à accepter ; la part ne s'applique qu'après accord ; de nouvelles conditions
   redemandent l'accord et les anciennes restent en vigueur d'ici là ; refus ou retrait possibles ; une ligne ne peut jamais être
   déplacée vers une autre personne ou un autre morceau ; droits de modification par colonne ; une invitation par personne et par 24 h.

Seconde relecture indépendante : 2 hauts (acceptation déplaçable en base ; remboursement pouvant s'intercaler pendant un virement),
4 moyens (réponse de Stripe perdue, invitations abusives, réponse sur des conditions changées, dates modifiables), 4 bas : tous corrigés
et testés (réservation « virement en cours » sous verrou, vérification chez Stripe des virements douteux, retard et pannes simulés).
178 tests et 19 parcours Chrome au vert.
