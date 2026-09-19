# syntax=docker/dockerfile:1
# Runtime Controller（ECR: agent-studio/runtime-controller）
# ビルドはリポジトリのルートで:
#   docker build --platform linux/amd64 -f runtime/controller/Dockerfile -t agent-studio/runtime-controller .

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- 1. ワークスペースの package.json だけを集める（ソースを変えても依存のインストールをやり直さないため）
FROM ${NODE_IMAGE} AS manifests
WORKDIR /src
COPY . .
RUN mkdir -p /manifests \
 && find . -name node_modules -prune -o -name package.json -print | xargs -I{} cp --parents {} /manifests/ \
 && cp yarn.lock .yarnrc.yml /manifests/

# ---- 2. ビルド（contracts → controller）
FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY --from=manifests /manifests/ ./
RUN yarn workspaces focus @agent-studio/contracts @agent-studio/runtime-controller
COPY tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY runtime/controller ./runtime/controller
RUN yarn workspace @agent-studio/contracts build \
 && yarn workspace @agent-studio/runtime-controller build
# 実行に要る依存だけを入れ直し、必要なファイルを /out にまとめる
RUN yarn workspaces focus --production @agent-studio/runtime-controller \
 && mkdir -p /out/packages/contracts /out/runtime/controller \
 && cp -a node_modules package.json /out/ \
 && cp -a packages/contracts/package.json packages/contracts/dist /out/packages/contracts/ \
 && cp -a runtime/controller/package.json runtime/controller/dist /out/runtime/controller/ \
 && for d in packages/contracts runtime/controller; do \
      if [ -d "$d/node_modules" ]; then cp -a "$d/node_modules" "/out/$d/"; fi; \
    done \
 && find /out -name "*.map" -delete

# ---- 3. 実行（root 以外）
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/ ./
USER node
WORKDIR /app/runtime/controller
CMD ["node", "dist/index.js"]
