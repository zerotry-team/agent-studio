# Agent Studio の Adapter の作り方（Builder 向けの契約）

このリポジトリには、Agent Studio の Agent が社内システムを使うための Adapter を置く。
Adapter は GitHub の CI（`.github/workflows/agent-studio.yml`）で検査・署名され、main へ merge されると
顧客の Runtime（Tool Gateway）に自動で導入されて Tool になる。

## ファイルの置き方

```
adapters/<connector-key>/
  agent-studio.adapter.json   # Adapter の説明（下記）。source は CI が付けるので書かない
  index.mjs                   # 本体。1 ファイルだけ
  index.test.mjs              # テスト（node --test で実行）
```

- `<connector-key>` は英小文字・数字・ハイフン（例: `factoring-review`）。`agent-studio.adapter.json` の `connector.key` と同じにする
- 1 回の変更で触る Adapter は 1 つだけにする

## agent-studio.adapter.json

```json
{
  "version": 1,
  "connector": { "key": "factoring-review", "display_name": "審査システム", "description": "社内の審査システムの読み取り" },
  "tools": [
    {
      "name": "list_pending_applications",
      "description": "審査待ちの申込を一覧にします",
      "risk": "read",
      "input_schema": { "type": "object", "properties": { "status": { "type": "string" } }, "additionalProperties": false },
      "output_schema": { "type": "object" }
    }
  ],
  "execution": { "kind": "http", "health_endpoint": "/health" },
  "network": { "outbound_domains": [], "private_network_required": true },
  "required_connections": [{ "kind": "runtime_secret", "description": "社内APIのトークン（Runtimeの環境変数から読む）" }]
}
```

- Tool 名は英小文字・数字・`_`（既存の Tool と重ならない名前にする）
- `risk` は `read` / `write` / `external_send` / `financial` / `destructive`。読み取りだけなら `read`
- `input_schema` のトップレベルは `type: "object"`

## index.mjs の決まり

- `import` してよいのは Node の組み込みモジュール（`node:http` など `node:` で始まるもの）だけ。npm のパッケージは使えない
- Runtime では Node の permission model で動く。ファイルの読み書き・子プロセスは使えない
- `process.env.HOST`（既定 127.0.0.1）と `process.env.PORT` で HTTP サーバーを起動する
- `GET <health_endpoint>` は 200 を返す
- Tool ごとに `POST /tools/<tool 名>` を受け付ける。本文は Tool の引数の JSON、応答は結果の JSON（200）
- 入力が正しくないときは 400 と `{ "error": "..." }`。社内 API の失敗は 502 と `{ "error": "..." }`
- 社内 API の URL・トークンはコードに書かず、`RUNTIME.md` にある環境変数から読む
- 応答には必要な項目だけを返す（個人情報や口座番号などを増やさない）

## テスト

- `index.test.mjs` は `node:test` と `node:assert` を使う。本物の社内 API には接続せず、テストの中で偽の API サーバーを立てる
- `node scripts/agent-studio/check.mjs` がすべての検査（形式・import・秘密情報・テスト）をまとめて行う。変更後に必ず実行して通す

社内 API の仕様は `docs/internal-apis/` にある。
