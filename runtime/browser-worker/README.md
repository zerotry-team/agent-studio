# Browser Worker

Playwright MCP（`@playwright/mcp`）を HTTP で公開するコンテナです。Tool Gateway の配下の MCP サーバーとして動き、Agent（Session Worker）からは直接つながりません（CRT-06）。

- ECS サービス `<prefix>-browser-worker`、Cloud Map 名 `browser.<prefix>.internal`、ポート `8931`
- 受信は runtime-core の SG からだけ（デプロイ契約 §5.2）
- Tool Gateway の設定（`upstream_mcp`）で、Agent に見せるツールを許可リストで絞る（例: `browser_navigate`、`browser_snapshot`、`browser_click`、`browser_type`）

## バージョン

| 項目 | 値 |
|---|---|
| ベースイメージ | `mcr.microsoft.com/playwright:v1.63.0-noble`（Node 24、ユーザー `pwuser` uid 1001、ブラウザは `/ms-playwright`） |
| `@playwright/mcp` | `0.0.80`（依存: `playwright-core@1.63.0-alpha-2026-08-31`） |
| Chromium | リビジョン `1243`（153.0.8010.12）。ベースイメージと `@playwright/mcp` が使う playwright-core で一致している |

`@playwright/mcp` は Playwright の alpha 版に依存しています。0.0.81 以降は Playwright 1.64 の alpha（Chromium 1246）を使うため、公開済みの公式イメージ（最新 v1.63.0）とはブラウザのリビジョンが合いません。上げるときは次を確認してください。

```bash
npm view @playwright/mcp@<版> dependencies          # 使う playwright-core の版
npm pack playwright-core@<その版> && tar -xzOf playwright-core-*.tgz package/browsers.json   # chromium の revision
docker run --rm mcr.microsoft.com/playwright:v<版>-noble ls /ms-playwright                     # イメージのブラウザ
```

## 起動引数

```text
playwright-mcp --headless --browser chromium --no-sandbox --isolated \
  --host 0.0.0.0 --port 8931 --output-dir /tmp/playwright-mcp
```

| 引数 | 理由 |
|---|---|
| `--headless` | 画面なし |
| `--browser chromium` | イメージ内の Chromium（Chrome for Testing）を使う。既定の `chrome` は Google Chrome を探すため入っていない |
| `--no-sandbox` | Fargate では Chromium のサンドボックス（user namespace）が使えない。隔離はコンテナ単位で行う |
| `--isolated` | プロフィールをディスクに残さない。**MCP のセッション（HTTP の接続）ごとに別のブラウザのコンテキスト** になる。Tool Gateway は Agent のセッションごとに別の MCP セッションでつなぐので、ログイン状態などはセッション間で共有されない（`--shared-browser-context` は付けない） |
| `--host 0.0.0.0 --port 8931` | VPC 内から受ける。エンドポイントは `/mcp`（Streamable HTTP）と `/sse`（旧方式） |

追加の引数はタスク定義の `command` で渡せます（`ENTRYPOINT` の後ろに付く）。

### Host ヘッダの検査（PLAYWRIGHT_MCP_ALLOWED_HOSTS）

Playwright MCP は `Host` ヘッダを検査し、既定では `localhost:8931` 以外を 403 にします。Tool Gateway は `browser.<prefix>.internal:8931` でつなぐため、イメージの既定は `PLAYWRIGHT_MCP_ALLOWED_HOSTS=*`（検査なし）にしています。

DNS リバインディング（ブラウザで開いたページから 127.0.0.1:8931 の MCP サーバーを操作される）への備えとして、タスク定義で実際の名前を渡すことを推奨します。

```text
PLAYWRIGHT_MCP_ALLOWED_HOSTS=browser.<prefix>.internal:8931
```

（ポートまで含めた `Host` ヘッダの値と完全一致で比較されます。カンマ区切りで複数指定できます。）

## ローカルで試す

```bash
docker build --platform linux/amd64 -f runtime/browser-worker/Dockerfile -t agent-studio/browser-worker:local .
docker run --rm -p 8931:8931 agent-studio/browser-worker:local
```

`runtime/tool-gateway/examples/tool-config.local.yaml` の `upstream_mcp` のコメントを外すと、Tool Gateway 経由で `browser_*` のツールを使えます。
