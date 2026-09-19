# agent-studio

企業ごとに分離された実行環境で業務 AI エージェントを動かす SaaS。Control Plane（Agent Studio）と Execution Plane（Company Runtime）に分かれる。
全体像は README.md、設計は docs/requirements.md と docs/architecture/。

## 守ること

- **組織の分離**: 組織に属するテーブルは `organization_id` + RLS + 複合外部キー `(organization_id, id)`。
  - DB アクセスは必ず `TenantDb.run/org`（backend/api/src/infrastructure/db/tenant-db.ts）を通す。組織をまたぐ処理は migrations の SECURITY DEFINER 関数（`SystemDb`）だけ
  - 新しいテーブルを足したら RLS のポリシーをマイグレーションに書く。結合テスト「組織に属するテーブルはすべて RLS が有効」が確認する
  - `organization_id` はリクエストの本文やパスから信用しない（ヘッダで選び、メンバーシップを確認する）
- **秘密情報**: 認証情報の値を DB やログに保存しない（参照だけ）。Session Worker（`codex exec-server`）の中身はモデルから読める前提で、認証情報も AWS の権限も置かない
- **契約**: 名前・環境変数・ポート・IAM は docs/architecture/deployment-contract.md、API は docs/architecture/api.md、型は packages/contracts。変えるときは関係するコードと Terraform を同時に直す
- **OpenAI Agents API**: 仕様は docs/reference/openai-agents-sdk.md（SDK の型から調べたもの）。承認の仕組みと webhook は API にないため、承認は Agent Studio / Tool Gateway 側で実装している
- UI・エラーメッセージ・コメントは日本語。技術用語より利用者に分かる言葉を使う

## 構成

- backend/api: Presentation（Hono: `presentation/`）→ Application（`application/`）→ Domain（`domain/`）/ Infrastructure（`infrastructure/`）。Worker は `worker/`
- frontend/web: Page → Action（`"use server"`）→ Service → Repository（Agent Studio API を呼ぶ）
- runtime/*: 顧客の AWS で動く。Agent Studio へはアウトバウンドの HTTPS だけ

## よく使うコマンド

```bash
yarn db:up && yarn db:bootstrap && yarn prisma:migrate:deploy && yarn prisma:seed
yarn dev:api / yarn dev:worker / yarn dev:web
yarn type-check && yarn test
yarn workspace @agent-studio/api test:integration   # PostgreSQL が必要（.env の DATABASE_URL / DIRECT_URL）
yarn prisma:migrate:dev --name <name>                # スキーマ変更（RLS などは SQL を手で追記）
```

Prisma の `migrate reset` はエージェントからは実行できない（ローカル DB を作り直すときは docker compose のボリュームを消す）。
