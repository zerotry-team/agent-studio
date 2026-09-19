# syntax=docker/dockerfile:1
# Tool Gateway（ECR: agent-studio/tool-gateway）
# ビルドはリポジトリのルートで:
#   docker build --platform linux/amd64 -f runtime/tool-gateway/Dockerfile -t agent-studio/tool-gateway .

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- 1. ワークスペースの package.json だけを集める（ソースを変えても依存のインストールをやり直さないため）
FROM ${NODE_IMAGE} AS manifests
WORKDIR /src
COPY . .
RUN mkdir -p /manifests \
 && find . -name node_modules -prune -o -name package.json -print | xargs -I{} cp --parents {} /manifests/ \
 && cp yarn.lock .yarnrc.yml /manifests/

# ---- 2. ビルド（contracts → tool-gateway）
FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY --from=manifests /manifests/ ./
RUN yarn workspaces focus @agent-studio/contracts @agent-studio/tool-gateway
COPY tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY runtime/tool-gateway ./runtime/tool-gateway
RUN yarn workspace @agent-studio/contracts build \
 && yarn workspace @agent-studio/tool-gateway build
# 実行に要る依存だけを入れ直し、必要なファイルを /out にまとめる
RUN yarn workspaces focus --production @agent-studio/tool-gateway \
 && mkdir -p /out/packages/contracts /out/runtime/tool-gateway \
 && cp -a node_modules package.json /out/ \
 && cp -a packages/contracts/package.json packages/contracts/dist /out/packages/contracts/ \
 && cp -a runtime/tool-gateway/package.json runtime/tool-gateway/dist runtime/tool-gateway/examples /out/runtime/tool-gateway/ \
 && for d in packages/contracts runtime/tool-gateway; do \
      if [ -d "$d/node_modules" ]; then cp -a "$d/node_modules" "/out/$d/"; fi; \
    done \
 && find /out -name "*.map" -delete

# ---- 3. 実行（root 以外）
FROM ${NODE_IMAGE}
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /out/ ./
USER node
WORKDIR /app/runtime/tool-gateway
EXPOSE 8080
CMD ["node", "dist/index.js"]
