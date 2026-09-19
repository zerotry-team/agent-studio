# syntax=docker/dockerfile:1
# Browser Worker（ECR: agent-studio/browser-worker）
# Playwright MCP を HTTP（Streamable HTTP: /mcp）で 0.0.0.0:8931 に公開する。Tool Gateway だけが呼ぶ（SG で制限）。
#
# ビルドはリポジトリのルートで:
#   docker build --platform linux/amd64 -f runtime/browser-worker/Dockerfile -t agent-studio/browser-worker .
#
# ベースイメージのブラウザ（/ms-playwright の chromium-1243）は、@playwright/mcp が使う
# playwright-core（1.63.0-alpha-2026-08-31）が期待するリビジョンと同じもの。
# どちらかを上げるときは、両方のリビジョンが一致することを確認する（README を参照）。
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ARG PLAYWRIGHT_MCP_VERSION=0.0.80

RUN npm install -g "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
 && npm cache clean --force \
 && playwright-mcp --version

ENV NODE_ENV=production
# Playwright MCP は Host ヘッダを検査する（既定では localhost:8931 だけを受け付け、Cloud Map の名前では 403 になる）。
# 接続先の名前はテナントごとに違うため、イメージの既定は検査なし（*）にし、受信は SG で runtime-core に限定する。
# タスク定義で PLAYWRIGHT_MCP_ALLOWED_HOSTS=browser.<prefix>.internal:8931 を渡すと、その名前だけを受け付ける（推奨）。
ENV PLAYWRIGHT_MCP_ALLOWED_HOSTS="*"
# ベースイメージの一般ユーザー（uid 1001）で動かす
USER pwuser
WORKDIR /home/pwuser
EXPOSE 8931

# --isolated: プロフィールをディスクに残さない。HTTP の接続（MCP のセッション）ごとに別のブラウザのコンテキストになる。
#             Tool Gateway は Agent のセッションごとに別の MCP セッションでつなぐ（CRT-06）。
# --no-sandbox: Fargate では Chromium のサンドボックス（user namespace）が使えないため。コンテナ自体で隔離する。
# 追加の引数（例: --allowed-hosts browser.<prefix>.internal）はタスク定義の command で渡せる。
ENTRYPOINT ["playwright-mcp", "--headless", "--browser", "chromium", "--no-sandbox", "--isolated", "--host", "0.0.0.0", "--port", "8931", "--output-dir", "/tmp/playwright-mcp"]
CMD []
