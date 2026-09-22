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

if [[ -n "${BUILDER_REPOSITORY_URL:-}" ]]; then
  for name in BUILDER_PROJECT_ID BUILDER_CHANGE_SET_ID BUILDER_CAPABILITY_TOPIC BUILDER_BASE_BRANCH BUILDER_BRANCH BUILDER_ADAPTER_PATH; do
    if [[ -z "${!name:-}" ]]; then
      log "Builder workspaceの必須設定がありません: $name"
      exit 64
    fi
  done
  repo="$WORKSPACE_DIRECTORY/repo"
  outputs="$WORKSPACE_DIRECTORY/outputs"
  mkdir -p "$outputs"
  if [[ -n "${BUILDER_TRANSFER_URL:-}" && -n "${BUILDER_TRANSFER_TOKEN:-}" && ! -d "$repo/.git" ]]; then
    # ECS: Controller が資格情報を使って clone した作業領域を Tool Gateway から受け取る（Worker は資格情報を持たない）
    log "準備済みの作業領域を受け取ります（change_set_id=${BUILDER_CHANGE_SET_ID}）"
    archive="$(mktemp /tmp/builder-input.XXXXXX)"
    ok=""
    for attempt in 1 2 3 4 5; do
      if curl -fsS --max-time 120 -H "Authorization: Bearer ${BUILDER_TRANSFER_TOKEN}" -o "$archive" "${BUILDER_TRANSFER_URL}/input"; then
        ok=1
        break
      fi
      sleep $((attempt * 2))
    done
    if [[ -z "$ok" ]]; then
      log "作業領域を受け取れませんでした"
      exit 70
    fi
    tar -xzf "$archive" -C "$WORKSPACE_DIRECTORY" --no-same-owner
    rm -f "$archive"
    test "$(git -C "$repo" rev-parse --abbrev-ref HEAD)" = "$BUILDER_BRANCH"
  fi
  if [[ -d "$repo/.git" ]]; then
    # Dockerのローカル実行ではControllerが資格情報をstdinだけで扱う準備処理から
    # 同じvolumeへcloneできる。再送時も既存workspaceを破壊しない。
    test "$(git -C "$repo" remote get-url origin)" = "$BUILDER_REPOSITORY_URL"
    log "準備済みの隔離Repositoryを使用します（change_set_id=${BUILDER_CHANGE_SET_ID}）"
  else
    log "Repositoryを資格情報非公開の準備処理でcloneします（change_set_id=${BUILDER_CHANGE_SET_ID}）"
    git clone --depth 1 --branch "$BUILDER_BASE_BRANCH" "$BUILDER_REPOSITORY_URL" "$repo"
    base_sha="$(git -C "$repo" rev-parse HEAD)"
    git -C "$repo" switch -c "$BUILDER_BRANCH"
    printf '%s\n' "$base_sha" > "$WORKSPACE_DIRECTORY/.builder-base-sha"
    chmod 0444 "$WORKSPACE_DIRECTORY/.builder-base-sha"
  fi
  if [[ -n "${BUILDER_TRANSFER_URL:-}" && -n "${BUILDER_TRANSFER_TOKEN:-}" ]]; then
    BUILDER_WORKSPACE_ROOT="$WORKSPACE_DIRECTORY" node /usr/local/lib/builder-sync.mjs &
    log "Builderの結果の回収を開始しました"
  fi
  WORKSPACE_DIRECTORY="$repo"
fi
cd "$WORKSPACE_DIRECTORY"

# Self-hostedではOpenAIのArtifacts APIからファイルを取り出せないため、作業領域の成果物を
# Tool Gateway経由でこのRunの成果物として送る（Builder Sessionは別の回収経路を使う）。
if [[ -n "${SESSION_OUTPUTS_URL:-}" && -n "${SESSION_OUTPUTS_TOKEN:-}" && -z "${BUILDER_REPOSITORY_URL:-}" ]]; then
  mkdir -p "$WORKSPACE_DIRECTORY/outputs"
  node /usr/local/lib/outputs-sync.mjs &
  log "作業領域の成果物の回収を開始しました"
fi

log "codex exec-server を起動します（environment_id=${ENVIRONMENT_ID}、workspace=${WORKSPACE_DIRECTORY}）"
exec env -u SESSION_OUTPUTS_URL -u SESSION_OUTPUTS_TOKEN -u BUILDER_TRANSFER_URL -u BUILDER_TRANSFER_TOKEN codex exec-server --remote "$REMOTE_URL" --environment-id "$ENVIRONMENT_ID"
