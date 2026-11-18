# Worker Sonikc : traitement audio (ffmpeg) et ménage. Construit depuis la racine du dépôt :
#   docker build -f worker/Dockerfile -t sonikc-worker .
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY worker ./worker
ENV NODE_ENV=production
USER node
CMD ["npx", "tsx", "worker/index.ts"]
