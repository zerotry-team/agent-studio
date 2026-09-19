# syntax=docker/dockerfile:1
# 受け入れシナリオ用の社内 API モック（ECR: agent-studio/demo-internal-api）
# ビルドはリポジトリのルートで:
#   docker build --platform linux/amd64 -f runtime/demo-internal-api/Dockerfile -t agent-studio/demo-internal-api .

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- 1. ワークスペースの package.json だけを集める（ソースを変えても依存のインストールをやり直さないため）
FROM ${NODE_IMAGE} AS manifests
WORKDIR /src
COPY . .
RUN mkdir -p /manifests \
 && find . -name node_modules -prune -o -name package.json -print | xargs -I{} cp --parents {} /manifests/ \
 && cp yarn.lock .yarnrc.yml /manifests/

# ---- 2. ビルド
FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY --from=manifests /manifests/ ./
RUN yarn workspaces focus @agent-studio/demo-internal-api
COPY tsconfig.base.json ./
COPY runtime/demo-internal-api ./runtime/demo-internal-api
RUN yarn workspace @agent-studio/demo-internal-api build
# 実行に要る依存だけを入れ直し、必要なファイルを /out にまとめる
RUN yarn workspaces focus --production @agent-studio/demo-internal-api \
 && mkdir -p /out/runtime/demo-internal-api \
 && cp -a node_modules package.json /out/ \
 && cp -a runtime/demo-internal-api/package.json runtime/demo-internal-api/dist /out/runtime/demo-internal-api/ \
 && if [ -d runtime/demo-internal-api/node_modules ]; then cp -a runtime/demo-internal-api/node_modules /out/runtime/demo-internal-api/; fi \
 && find /out -name "*.map" -delete

# ---- 3. 実行（root 以外）
FROM ${NODE_IMAGE}
ENV NODE_ENV=production PORT=8090
WORKDIR /app
COPY --from=build /out/ ./
USER node
WORKDIR /app/runtime/demo-internal-api
EXPOSE 8090
CMD ["node", "dist/index.js"]
