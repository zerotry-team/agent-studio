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
RUN yarn workspaces focus @agent-studio/browser-session-worker
COPY tsconfig.base.json ./
COPY runtime/browser-session-worker ./runtime/browser-session-worker
RUN yarn workspace @agent-studio/browser-session-worker build \
 && yarn workspaces focus --production @agent-studio/browser-session-worker \
 && mkdir -p /out/runtime/browser-session-worker \
 && cp -a node_modules package.json /out/ \
 && cp -a runtime/browser-session-worker/package.json runtime/browser-session-worker/dist /out/runtime/browser-session-worker/ \
 && if [ -d runtime/browser-session-worker/node_modules ]; then cp -a runtime/browser-session-worker/node_modules /out/runtime/browser-session-worker/; fi \
 && find /out -name "*.map" -delete

FROM mcr.microsoft.com/playwright:v1.63.0-noble
ENV NODE_ENV=production \
    PORT=8931 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOME=/home/pwuser
WORKDIR /app
COPY --from=build /out/ ./
RUN mkdir -p /tmp/browser-session /workspace \
 && chown -R pwuser:pwuser /tmp/browser-session /workspace /app
USER pwuser
WORKDIR /app/runtime/browser-session-worker
EXPOSE 8931
CMD ["node", "dist/index.js"]
