#!/usr/bin/env bash
# Session Worker の起動スクリプト。
# REMOTE_URL / ENVIRONMENT_ID は Controller が RunTask の containerOverrides で渡し、
# CODEX_API_KEY（環境キー）はタスク定義の secrets で注入される。値はログに出さない。
set -euo pipefail

log() {
  echo "[session-worker] $*" >&2
}

missing=()
for name in REMOTE_URL ENVIRONMENT_ID CODEX_API_KEY; do
  if [[ -z "${!name:-}" ]]; then
    missing+=("$name")
  fi
done
if (( ${#missing[@]} > 0 )); then
  log "必須の環境変数が設定されていません: ${missing[*]}"
  exit 64
fi

WORKSPACE_DIRECTORY="${WORKSPACE_DIRECTORY:-/workspace}"
mkdir -p "$WORKSPACE_DIRECTORY"
cd "$WORKSPACE_DIRECTORY"

log "codex exec-server を起動します（environment_id=${ENVIRONMENT_ID}、workspace=${WORKSPACE_DIRECTORY}）"
exec codex exec-server --remote "$REMOTE_URL" --environment-id "$ENVIRONMENT_ID"
