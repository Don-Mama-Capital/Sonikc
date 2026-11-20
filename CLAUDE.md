# Sonikc — règles de travail

Sonikc est une web app pour beatmakers : ranger ses beats, les partager, savoir qui les écoute, les vendre.
Spec de référence : « Spec V1 — Sonikc » (doc partagé avec le propriétaire du projet).

## Boucle de travail (validée par le propriétaire)

Chaque lot : cadrer (critères écrits avant le code) → réfléchir → produire → vérifier (preuves objectives) → décider.
- Fini = tous les critères bloquants du lot au vert, avec une preuve (test, build, capture).
- 3 itérations maximum par lot ; arrêt immédiat si une itération ne réduit pas les bloquants ou si la même erreur revient.
- Lot validé = gelé (on n'y touche qu'en cas de régression détectée par un test).
- Les idées et nouvelles features vont au registre, jamais dans le lot en cours. Aucune feature du registre n'est codée sans validation.
- Relecture indépendante pour les lots à risque (droits d'accès, paiement, suivi des écoutes).
- Une PR par phase ; point d'étape avec le propriétaire avant la phase suivante.

## Conventions

- Textes de l'interface en français, tutoiement, phrases courtes. Aucun texte, nom ou visuel repris de vvault.
- Toute donnée utilisateur passe par `withUser()` (rôle `sonikc_app` + RLS). `asService()` est réservé à l'auth, au worker et aux flux de paiement (achat, webhook Stripe, livraison, virements, remboursements) ; l'app ne fait que lire les ventes. (Règle modifiée le 20/11/2026 avec l'accord du propriétaire ; avant : « `asService()` est réservé à l'auth et au worker. »)
- Les offres et leurs limites viendront d'un seul fichier de configuration (phase 5) : aucun texte d'offre écrit en dur.
- Pas de fichier audio servi sans URL signée qui expire.

## Commandes

- `npm run db` : Postgres local (embarqué, port 54322) + migrations.
- `npm run dev` et `npm run worker` : app et traitement audio.
- `npm test` : tests unitaires et d'intégration (Postgres jetable).
- `npm run build && npm run test:e2e` : recette dans Chrome (`CHROME_PATH` si Chrome n'est pas dans /usr/bin).
- `npm run fixtures` : régénère les 10 beats de référence.
