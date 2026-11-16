# Lot 1.5 — Consolidation de la phase 1

Critères écrits avant le code ; ils ne changent pas en cours de lot. Fini = tous les critères bloquants au vert, avec une preuve.

| # | Critère bloquant | Preuve attendue |
| --- | --- | --- |
| 1 | L'app tourne sous Next 16 ; build, 55+ tests et parcours E2E au vert ; `npm audit --omit=dev` sans faille haute | Sorties de build, de tests et d'audit |
| 2 | Pilote de stockage Supabase : envoi, lecture signée, suppression, écriture unique ; même interface que le pilote local | Tests contre une simulation de l'API Supabase Storage |
| 3 | Pilote email Resend : bon format de requête ; en production, refus de démarrer sans clé | Tests contre une simulation de l'API Resend |
| 4 | Ménage : morceaux en corbeille depuis plus de 30 jours supprimés avec leurs fichiers ; envois abandonnés depuis plus de 24 h supprimés ; rien de récent touché | Tests d'intégration |
| 5 | ZIP déballé en flux (l'archive n'est jamais chargée entière en mémoire) ; plafonds et tests ZIP existants au vert | Tests existants + test de flux |
| 6 | Tonalités : écriture usuelle par défaut (Eb maj, F# min, Bb maj…), dièses ou bémols forcés au choix | Test des 24 tonalités |
| 7 | Accessibilité Lighthouse ≥ 90 sur connexion, bibliothèque et page morceau (mobile) | Rapports Lighthouse |
| 8 | Intégration continue : à chaque PR, tests et E2E lancés sur GitHub et au vert | Exécution GitHub Actions |
| 9 | Image du worker (ffmpeg compris) construite avec succès | Exécution GitHub Actions |

Hors critères (dépend de tes secrets GitHub) : migration du schéma vers `sonikc-dev` et test de fumée réel contre Supabase. Le workflow sera prêt ; il tournera dès que les 3 secrets existent.

## Résultat (itération 1) — 9/9 critères au vert, lot gelé

| # | État | Preuve |
| --- | --- | --- |
| 1 | ✅ | Next 16.4.6 ; `tsc` sans erreur ; 74 tests unitaires et d'intégration ; 9 parcours E2E ; `npm audit --omit=dev` : 0 faille |
| 2 | ✅ | `tests/unit/drivers.test.ts` contre un faux serveur Supabase Storage (envoi, URL signée, suppression, écriture unique, dépassement de taille) |
| 3 | ✅ | `tests/unit/drivers.test.ts` : requête Resend vérifiée ; en production, démarrage refusé sans clé ou avec les pilotes locaux |
| 4 | ✅ | `tests/unit/housekeeping.test.ts` : corbeille à 31 j supprimée avec ses fichiers, 29 j gardée ; envoi abandonné à 25 h supprimé, récent et terminé gardés ; nouvelle version abandonnée sans toucher la version prête. Le worker lance le ménage toutes les heures |
| 5 | ✅ | ZIP de 120 Mo déballé avec un pic mémoire < 60 Mo ; ZIP corrompu refusé ; plafonds 200 fichiers / 600 Mo |
| 6 | ✅ | `tests/unit/keys.test.ts` (24 tonalités en écriture usuelle, dièses/bémols forcés, saisie libre « si bémol majeur ») ; E2E : `Bb maj` par défaut → `A# maj` → `Bb maj`. Le bouton passe Auto → ♯ → ♭ |
| 7 | ✅ | `npm run lighthouse`, mobile 375 px : accessibilité **100** sur connexion, bibliothèque et page morceau (perf 99-100, bonnes pratiques 96-100, SEO 100) |
| 8 | ✅ | [Exécution GitHub Actions](https://github.com/Don-Mama-Capital/Sonikc/actions/runs/43846331723) sur la PR : audit 0 faille, 74 tests, build, 9 parcours dans Chrome |
| 9 | ✅ | `worker/Dockerfile` (Node 22 + ffmpeg 5.1) construit dans la [même exécution](https://github.com/Don-Mama-Capital/Sonikc/actions/runs/43846331723), `ffmpeg` et `ffprobe` vérifiés dans l'image |

Ajouté en plus, sans nouvelle feature : migration `0002` qui ferme l'accès des rôles publics de Supabase (`anon`, `authenticated`) et active la RLS sur toutes les tables, prouvée par `tests/unit/supabase-hardening.test.ts` (base qui imite les droits par défaut de Supabase).

### Côté Supabase (dès que les 3 secrets sont ajoutés)

Le workflow « Supabase dev » (onglet Actions → Run workflow) : applique les migrations, vérifie qu'aucune table n'est lisible publiquement, crée le compartiment privé `audio`, puis fait un aller-retour de fichier (écriture, lecture signée, refus sans signature, suppression). Secrets attendus : `SUPABASE_DB_URL` (chaîne « Session pooler »), `SUPABASE_URL`, `SUPABASE_SECRET_KEY`.
