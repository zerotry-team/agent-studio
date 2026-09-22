# syntax=docker/dockerfile:1
# Session Worker（ECR: agent-studio/session-worker）
# セッションごとに 1 タスク起動し、`codex exec-server` で OpenAI のセッションの実行環境になる。
# 信頼しない領域: 業務システムの認証情報と AWS の権限を持たせない（SEC-12）。持つのは環境キー（CODEX_API_KEY）だけ。
#
# ビルドはリポジトリのルートで:
#   docker build --platform linux/amd64 -f runtime/session-worker/Dockerfile -t agent-studio/session-worker .

FROM node:22-bookworm-slim

# `codex exec-server --remote/--environment-id` を確認したバージョン（更新するときは --help で引数を確認する）
ARG CODEX_VERSION=0.155.1

# Agent がワークスペースで使う基本的な道具
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates bash python3 ripgrep curl \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force \
 && codex --version

RUN groupadd --gid 10001 worker \
 && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/worker --shell /bin/bash worker \
 && mkdir -p /workspace \
 && chown worker:worker /workspace

COPY --chmod=0755 runtime/session-worker/entrypoint.sh /usr/local/bin/session-worker-entrypoint
COPY --chmod=0755 runtime/session-worker/workspace-builder-entrypoint /usr/local/bin/workspace-builder-entrypoint
COPY --chmod=0644 runtime/session-worker/workspace-result.mjs /usr/local/lib/workspace-result.mjs
COPY --chmod=0644 runtime/session-worker/outputs-sync.mjs /usr/local/lib/outputs-sync.mjs

ENV HOME=/home/worker \
    WORKSPACE_DIRECTORY=/workspace
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/session-worker-entrypoint"]
