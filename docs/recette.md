# Recette utilisateurs — Sonikc V1

But : vérifier l'app et son environnement comme si de vrais utilisateurs s'en servaient, en même temps, du début à la fin.
Critères écrits avant le code (boucle du projet). Une anomalie trouvée = corrigée si c'est une régression (test à l'appui),
sinon notée au registre. 3 itérations au plus.

## Deux niveaux

| Niveau | Où | Quoi |
| --- | --- | --- |
| A. Simulation complète | En local et à chaque PR (CI) | App compilée (`next start`, mode production), **worker réel** dans son propre processus (ffmpeg, tâches périodiques), Postgres, stockage local, faux Stripe et faux Google, emails dans une boîte locale. Plusieurs utilisateurs en parallèle, ordinateur et mobile. |
| B. Environnement réel | GitHub, lancé à la main (onglet Actions → « Recette ») | Même app et même worker sur la machine GitHub, mais **base et stockage Supabase dev** et **vrai Stripe en mode test** (webhooks reçus par la CLI Stripe). Comptes de recette reconnaissables (`recette+…@sonikc.test`) et supprimés à la fin. |

L'app n'a pas encore d'hébergement : le niveau B fait tourner l'app sur la machine GitHub. La même recette pourra viser l'adresse
de l'hébergement le jour où il existera (`RECETTE_URL`).

## Personnages

| Qui | Rôle |
| --- | --- |
| Lina | Productrice, offre gratuite, sur téléphone puis ordinateur |
| Max | Producteur, offre Studio, vend ses beats, a un collaborateur |
| Sami | Collaborateur de Max (part de 30 %) |
| Inès | Artiste, écoute connectée, reçoit des envois, garde des liens dans « Reçus » |
| Visiteurs | Auditeurs anonymes : certains refusent les cookies, d'autres acceptent |
| Jules | Acheteur sans compte |
| Nora | Productrice qui teste l'offre Pro puis résilie |

## Parcours et critères bloquants (niveau A)

| # | Parcours | Critère bloquant | Preuve |
| --- | --- | --- | --- |
| R1 | Lina s'inscrit (code email), crée son profil, envoie des beats (WAV, MP3, ZIP), les range (dossier, renommer, corbeille, restaurer), ajoute une version, écoute | Chaque beat est analysé (BPM et tonalité affichés) par le worker réel ; rien de perdu ; mobile utilisable | test + captures mobile et ordinateur |
| R2 | Lina partage ; visiteurs (refus / accord) et Inès (connectée) écoutent, Inès met en favori, télécharge, garde le lien dans « Reçus » | Sans accord : aucun cookie de mesure ; Lina voit les écoutes, le nom d'Inès, les notifications ; lien avec mot de passe refusé en gratuit avec le bon message | test + captures |
| R3 | Max importe des contacts, crée un groupe, envoie un beat avec relance ; un destinataire ouvre l'email, écoute, se désinscrit | Emails partis, lien suivi, désinscription respectée (aucun nouvel envoi) | test |
| R4 | Max met en vente avec licences et une part pour Sami (invitation acceptée) ; Jules achète (case de renonciation), reçoit fichiers, licence et facture ; Max voit la vente ; une vente est remboursée ; une exclusive ne se vend qu'une fois | Montants, TVA, part de Sami et email de livraison justes ; exclusive retirée de la vente | test |
| R5 | Nora atteint une limite de l'offre gratuite, prend l'essai Pro, la limite saute ; elle résilie ; un nouveau compte avec la même adresse n'a pas de second essai | Message de limite clair ; offre appliquée et retirée au bon moment | test |
| R6 | Inès exporte ses données puis supprime son compte ; Sami (argent dû) doit choisir entre activer ses reversements et renoncer | Export complet ; plus de connexion possible ; ventes de Max intactes | test |
| R7 | Un utilisateur essaie d'ouvrir ce qui n'est pas à lui (bibliothèque, statistiques, fichiers, lien révoqué, mauvais mot de passe) ; titres piégés (`<img onerror>`) | Toujours refusé (401/403/404), jamais d'exécution de script, fichiers audio seulement par URL signée | test |
| R8 | Charge : 5 producteurs et 40 auditeurs en même temps sur les mêmes liens | 0 erreur serveur ; pages publiques p95 < 1,5 s (local) ; écoutes comptées exactement | rapport chiffré |
| R9 | Sur tous les parcours : erreurs de la console, réponses 5xx, accessibilité (axe) des écrans clés | 0 erreur console imprévue, 0 réponse 5xx, 0 problème d'accessibilité « grave » ou « critique » | rapport |

## Niveau B — environnement réel

| # | Critère bloquant | Preuve |
| --- | --- | --- |
| B1 | Inscription, envoi d'un beat stocké dans Supabase, analyse par le worker, écoute par URL signée Supabase | journal du workflow |
| B2 | Partage et écoutes enregistrées dans la base Supabase (rôles et RLS réels) | journal |
| B3 | Achat avec le vrai Stripe en mode test : session Checkout, paiement par carte de test, webhook reçu, livraison | journal (si Stripe affiche une vérification anti-robot, le paiement est marqué « non vérifiable automatiquement », pas réussi) |
| B4 | Charge réduite (2 producteurs, 15 auditeurs) : 0 erreur serveur, temps relevés | rapport |
| B5 | Nettoyage : tous les comptes de recette supprimés par le parcours de suppression ; aucun fichier de recette laissé | journal |
