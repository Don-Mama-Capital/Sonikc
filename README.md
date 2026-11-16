# Sonikc

Range tes beats, partage-les, sache qui les écoute.

Web app Next.js + Postgres. Phase 1 livrée : compte sans mot de passe, envoi de fichiers audio (WAV, MP3, AIFF, FLAC, ZIP),
analyse automatique (BPM, tonalité, forme d'onde, empreinte SHA-256), bibliothèque (dossiers, projets, versions, recherche,
corbeille) et lecteur qui continue entre les pages.

## Démarrer en local

Prérequis : Node 22, ffmpeg et ffprobe.

```bash
npm install
cp .env.example .env        # puis remplace APP_SECRET par une longue chaîne aléatoire
npm run db                  # terminal 1 : Postgres local + migrations
npm run dev                 # terminal 2 : l'app sur http://localhost:3000
npm run worker              # terminal 3 : traitement des fichiers envoyés
```

En local, les emails (codes de connexion) sont écrits dans `.data/mail/` au lieu d'être envoyés.

## Tests

```bash
npm test                          # 49 tests : accès, connexion, envoi, analyse audio, bibliothèque
npm run build && npm run test:e2e # 9 parcours dans Chrome
```

Voir `docs/phase-1.md` pour le rapport de la phase 1 et `CLAUDE.md` pour les règles de travail.
