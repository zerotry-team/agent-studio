# syntax=docker/dockerfile:1.7
#
# Agent Studio Web（Next.js standalone）
# ビルドコンテキストはリポジトリのルート:
#   docker build --platform linux/amd64 -f frontend/web/Dockerfile .
#
# 実行時の環境変数（docs/architecture/deployment-contract.md §4.4）:
#   APP_BASE_URL, API_INTERNAL_URL, AUTH_MODE, COGNITO_DOMAIN, COGNITO_CLIENT_ID,
#   COGNITO_CLIENT_SECRET, SESSION_SECRET
# イメージは一度だけビルドし、これらは実行時に渡す（ビルド時には不要）。

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------
# 1. 依存関係（web と contracts だけをインストールする）
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

COPY package.json yarn.lock .yarnrc.yml ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY frontend/web/package.json frontend/web/package.json

RUN --mount=type=cache,target=/root/.yarn/berry/cache,sharing=locked \
    yarn workspaces focus @agent-studio/web @agent-studio/contracts

# ---------------------------------------------------------------------------
# 2. ビルド（contracts → next build）
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY frontend/web frontend/web

RUN yarn workspace @agent-studio/contracts build \
 && yarn workspace @agent-studio/web build

# ---------------------------------------------------------------------------
# 3. 実行（standalone の出力だけを含める）
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3201 \
    HOSTNAME=0.0.0.0
WORKDIR /app

# モノレポの standalone 出力は、リポジトリのルートからの相対パスで配置される
#   /app/frontend/web/server.js, /app/node_modules/...
COPY --from=build --chown=node:node /repo/frontend/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/frontend/web/.next/static ./frontend/web/.next/static
COPY --from=build --chown=node:node /repo/frontend/web/public ./frontend/web/public

USER node
EXPOSE 3201

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3201) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "frontend/web/server.js"]
