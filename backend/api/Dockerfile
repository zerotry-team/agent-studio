# syntax=docker/dockerfile:1.7
# Agent Studio API / Worker / マイグレーション（同じイメージをコマンドで使い分ける）
#   docker build -f backend/api/Dockerfile .
#   API:          node dist/index.js（既定）
#   Worker:       node dist/worker.js
#   Migration:    node dist/scripts/migrate.js
FROM node:22-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# yarn.lock の整合性を保つため、すべてのワークスペースの package.json を置く
FROM base AS manifests
COPY package.json yarn.lock .yarnrc.yml ./
COPY packages/contracts/package.json packages/contracts/
COPY backend/api/package.json backend/api/
COPY frontend/web/package.json frontend/web/
COPY runtime/controller/package.json runtime/controller/
COPY runtime/tool-gateway/package.json runtime/tool-gateway/
COPY runtime/demo-internal-api/package.json runtime/demo-internal-api/

FROM manifests AS build
RUN yarn workspaces focus @agent-studio/api @agent-studio/contracts
COPY tsconfig.base.json ./
COPY prisma prisma
COPY packages/contracts packages/contracts
COPY backend/api backend/api
RUN node node_modules/prisma/build/index.js generate --config=prisma/prisma.config.ts \
  && yarn workspace @agent-studio/contracts build \
  && yarn workspace @agent-studio/api build

FROM manifests AS prod-deps
RUN yarn workspaces focus @agent-studio/api --production
COPY prisma prisma
RUN node node_modules/prisma/build/index.js generate --config=prisma/prisma.config.ts

FROM base AS runtime
ENV NODE_ENV=production
# RDS の TLS 証明書を検証するための CA（DB_SSL_CA_PATH の既定値）
RUN curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /etc/ssl/certs/rds-global-bundle.pem
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=prod-deps /app/prisma prisma
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages/contracts/package.json packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/backend/api/package.json backend/api/package.json
COPY --from=build /app/backend/api/dist backend/api/dist
WORKDIR /app/backend/api
USER node
EXPOSE 3200
CMD ["node", "dist/index.js"]
