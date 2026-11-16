# Phase 1 — Socle : rapport

Date : 16 novembre 2026. Les 4 lots de la phase 1 sont au vert. 55 tests automatiques et 9 parcours dans Chrome passent, après une relecture de sécurité indépendante dont les 7 remarques sont corrigées.

## Critères bloquants

| Lot | Critère | Résultat | Preuve |
| --- | --- | --- | --- |
| 1.1 Compte | Inscription et connexion sans mot de passe | Vert | `tests/e2e/auth.spec.ts` (parcours complet dans Chrome), `tests/unit/auth.test.ts` |
| 1.1 Compte | Identifiant unique refusé en double | Vert | test unitaire (casse différente comprise) + E2E onboarding |
| 1.1 Compte | Code expiré ou 5 erreurs = refusé | Vert | `auth.test.ts` : expiration, 5 erreurs grillent même le bon code, code à usage unique, limites par adresse et par IP |
| 1.2 Envoi | WAV, MP3, AIFF, FLAC acceptés | Vert | `tests/unit/pipeline.test.ts` (4 formats), E2E |
| 1.2 Envoi | Aperçu écoutable et forme d'onde générés | Vert | `pipeline.test.ts` (aperçu MP3 servi par URL signée, 800 points) |
| 1.2 Envoi | Empreinte SHA-256 calculée à l'envoi | Vert | `pipeline.test.ts` : empreinte = empreinte du fichier d'origine |
| 1.2 Envoi | Titre sans extension | Vert | `pipeline.test.ts`, E2E |
| 1.2 Envoi | BPM et tonalité détectés et modifiables (10 fichiers de référence) | Vert | `tests/unit/audio-detect.test.ts` : 10 sur 10 exacts ; modification testée en unitaire et en E2E |
| 1.3 Bibliothèque | Déplacer, renommer, supprimer sans perte | Vert | `tests/unit/library.test.ts` (suppression d'un dossier = son contenu remonte ; corbeille restaurable), E2E |
| 1.3 Bibliothèque | v1, v2, master sous un même morceau | Vert | `pipeline.test.ts` |
| 1.3 Bibliothèque | Recherche par titre, BPM, tonalité, tag | Vert | `library.test.ts`, E2E (filtre BPM) |
| 1.4 Lecteur | Lecture continue en changeant de page | Vert | `tests/e2e/player.spec.ts` : le son continue et avance après deux navigations |
| 1.4 Lecteur | Utilisable à 375 px | Vert | `player.spec.ts` : aucun défilement horizontal, boutons ≥ 40 px, captures |

Accès : `tests/unit/rls.test.ts` vérifie qu'un utilisateur ne lit, ne modifie, ne supprime ni ne référence le contenu d'un autre, et que le rôle applicatif n'a aucun accès aux sessions, codes et comptes.

## Itérations

- Socle : 1 correction (triggers de propriété séparés par table).
- 1.2, détection du tempo : itération 1 = 7 sur 10 (erreurs de demi-tempo et de 2/3 dues aux charlestons). Itération 2 : tempo calculé sous 1,5 kHz + contrôle du demi-tempo → 10 sur 10.
- 1.2, mise en file des traitements : le rôle applicatif n'avait pas le droit d'écrire dans `jobs`. Corrigé par une fonction qui vérifie que l'objet appartient à l'utilisateur.
- Recette : 2 sélecteurs de test à corriger, et une page trop large de 39 px à 375 px (empreinte SHA-256 sans retour à la ligne). Après l'ajout du réglage dièses/bémols, le test mobile a détecté un nouveau débordement de 31 px dans l'en-tête, corrigé.

## Écarts par rapport à la spec, à valider

1. **Connexion maison au lieu de Supabase Auth.** Codes à 6 chiffres hachés, expiration 10 min, 5 essais, limites par adresse et par IP, sessions hachées en base. Raison : tout tester en local sans le service Supabase, que l'environnement ne permet pas de faire tourner.
2. **Connexion Google reportée.** Il faut un identifiant client Google ; à brancher à la mise en ligne.
3. **Base locale = Postgres 17 embarqué**, pas la pile Supabase complète. Le schéma et les règles d'accès sont du Postgres standard, compatibles Supabase.
4. **Stockage local** derrière une interface ; le pilote Supabase Storage sera écrit avant la mise en ligne.
5. **Réglage dièses/bémols ajouté** (bouton ♯/♭ dans l'en-tête), conformément au correctif n° 14 de l'audit.

## Limites connues

- La détection BPM et tonalité est validée sur 10 beats **synthétiques**. Sa justesse sur de vraies prods n'est pas encore mesurée ; le BPM et la tonalité restent modifiables. Le contrôle du demi-tempo a été réglé sur un seul cas : à surveiller avec de vrais fichiers.
- Le traitement audio a besoin de ffmpeg : le worker devra tourner sur un serveur à part (Vercel ne fournit pas ffmpeg).
- Un ZIP est déballé en mémoire (limite 300 Mo).
- La corbeille ne se vide pas encore automatiquement.

## Relecture de sécurité indépendante

Un agent qui n'avait pas écrit le code a relu en lecture seule les droits d'accès, l'authentification, les fichiers et les routes.

| Critère | Verdict |
| --- | --- |
| Isolation entre utilisateurs | Vert |
| Sessions, codes, table des comptes | À surveiller (limites de débit), corrigé |
| Fichiers et URL signées, chemins, jeton d'envoi | Vert |
| Protection CSRF | Vert |
| Injection SQL | Vert |

Ses 7 remarques sont corrigées, chacune couverte par un test (`tests/unit/hardening.test.ts`) :

1. L'IP servant aux limites de débit était lue dans `X-Forwarded-For`, que le client peut falsifier. Elle vient maintenant uniquement de l'en-tête de l'hébergeur (`TRUSTED_IP_HEADER`).
2. Les demandes de code simultanées pouvaient dépasser la limite, et un attaquant disposait d'environ 25 essais par quart d'heure. Il y a maintenant un verrou par adresse et un plafond de 10 erreurs par heure, tous codes confondus.
3. Archive ZIP piégée : la taille décompressée est plafonnée à 600 Mo et le nombre de fichiers à 200.
4. Le jeton d'envoi permettait de remplacer un fichier déjà reçu. L'écriture est maintenant unique (409).
5. Le `search_path` des fonctions privilégiées inclut désormais `pg_temp`, en dernière position.
6. La version courante doit appartenir au même morceau, et le dossier créé par un import au même propriétaire.
7. Une écriture sans en-tête Origin est refusée si le navigateur signale une requête venue d'un autre site.

Dépendances : `npm audit` signale une faille dans le PostCSS embarqué par Next 15. Il ne sert qu'à compiler nos propres styles. À traiter en passant à Next 16 lors d'une prochaine phase.
