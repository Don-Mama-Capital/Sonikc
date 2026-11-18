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
