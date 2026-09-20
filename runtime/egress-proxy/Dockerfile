# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS manifests
WORKDIR /src
COPY . .
RUN mkdir -p /manifests \
 && find . -name node_modules -prune -o -name package.json -print | xargs -I{} cp --parents {} /manifests/ \
 && cp yarn.lock .yarnrc.yml /manifests/

FROM node:22-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY --from=manifests /manifests/ ./
RUN yarn workspaces focus @agent-studio/egress-proxy
COPY tsconfig.base.json ./
COPY runtime/egress-proxy ./runtime/egress-proxy
RUN yarn workspace @agent-studio/egress-proxy build

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3128
WORKDIR /app
COPY --from=build /app/runtime/egress-proxy/dist ./dist
USER node
EXPOSE 3128
CMD ["node", "dist/index.js"]
