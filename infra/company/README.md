# infra/company（テナント Runtime）

テナント（企業）ごとのディレクトリに `config.yaml` と、ステージごとのルートモジュール（`production/`、`staging/`）を置く。
ルートモジュールは `config.yaml` を読んで `infra/modules/tenant-runtime` を呼ぶだけなので、**テナントの設定は `config.yaml` だけで変える**。

```text
infra/company/
└── sample-a-company/        # ディレクトリ名 = Agent Studio の組織の slug
    ├── config.yaml          # テナントの設定（組織 ID、接続先、ツール設定など）
    ├── production/          # state: company/sample-a-company/production/terraform.tfstate
    └── staging/             # state: company/sample-a-company/staging/terraform.tfstate
```

リソース名の接頭辞は `as-<short_name>-<prod|stg>`（例: `as-sample-a-prod`）。Agent Studio に登録する IAM ロールは `<接頭辞>-runtime`。

## テナントを追加する手順

例として `sample-b-company`（short_name `sample-b`）の production を追加する。

1. **AWS アカウントを用意する**（パターン A: Organizations の Companies OU に作る。パターン B: 顧客のアカウント）
2. **アカウントを bootstrap する**（管理者が 1 回だけ。`infra/bootstrap/README.md`）
   - `create_ecr_repositories = false`
   - `github_environments = ["company-sample-b-company-production"]`
3. **イメージを pull できるようにする**: 組織外のアカウントなら、Agent Studio 側のアカウントの bootstrap で `ecr_pull_account_ids` に追加して適用する
4. **Agent Studio で組織を作り**、組織 ID（UUID）を控える
5. **ディレクトリをコピーする**
   ```bash
   cp -R infra/company/sample-a-company infra/company/sample-b-company
   rm -rf infra/company/sample-b-company/*/.terraform
   ```
6. **`config.yaml` を書き換える**: `organization_id`、`slug`、`short_name`、`stages.<stage>`（`aws_account_id`、`agent_studio_url`、`runtime_server_id`）、`runtime`（`connections`、`tools` など）
   - `agent_studio_url` / `runtime_server_id` は `infra/agent-studio/<env>` の出力 `public_url` / `runtime_server_id`
   - 使わないステージは `stages` から消し、そのディレクトリも消す
   - `versions.tf` のコメントにある state のキーも新しい slug に直す（実際のキーは CI が渡す）
7. **GitHub Environment `company-sample-b-company-production` を作り**、変数を設定する（`infra/README.md` の「GitHub Environment」）
8. **CI で適用する**（イメージのタグは Agent Studio 側と同じ commit SHA）
9. **出力 `next_steps` に従う**: Agent Studio での Runtime の登録 → Bootstrap Token の登録 → 業務システムの認証情報の登録
   ```bash
   terraform -chdir=infra/company/sample-b-company/production output -raw next_steps
   ```

## config.yaml の主な項目

| 項目 | 内容 |
|---|---|
| `organization_id` | Agent Studio の組織 ID。staging の Agent Studio は DB が別なので、`stages.staging.organization_id` で上書きする |
| `stages.<stage>.aws_account_id` | 適用先のアカウント ID。書いておくと別アカウントへの誤適用を防げる |
| `stages.<stage>.runtime_id` | Runtime を登録したあとに表示される ID（タグ用） |
| `stages.<stage>.runtime` | `runtime` の 1 階層目のキーをステージごとに上書きする |
| `runtime.browser_enabled` / `demo_internal_api_enabled` | Browser Worker / 社内 API モックを動かすか |
| `runtime.allowed_internal_cidrs` | Tool Gateway から到達を許す社内ネットワーク |
| `runtime.extra_allowed_domains` | DNS Firewall で追加で許可するドメイン。**Browser Worker で開くサイトや、名前で呼ぶ社内システムもここに入れる**（VPC 内の名前解決はすべて許可リスト方式） |
| `runtime.connections` | 業務システムの接続名。空のシークレット `agent-studio/runtime/<short_name>/<stage>/connections/<名前>` を作る |
| `runtime.tools` | Tool Gateway のツール設定（`RuntimeToolConfig`）。SSM パラメータ `/<接頭辞>/tool-config` に JSON で入る。文字列中の `<prefix>` は接頭辞に置き換わる |

`runtime.tools` を変えて適用すると、Tool Gateway のタスク定義が更新されて再起動し、新しい設定を読み込む。
スキーマは `packages/contracts/src/runtime-config.ts`（Tool Gateway が起動時に検証する）。

## 公開リポジトリで見せない値

リポジトリが公開のため、次の値は config.yaml に書かず、GitHub Environment `company-<tenant>-<stage>` のシークレットで渡す
（infra/bootstrap の `github_environment_secrets` で設定できる）。

| シークレット | 内容 |
|---|---|
| `AWS_ACCOUNT_ID` | テナントのアカウント ID（bootstrap が自動で設定） |
| `IMAGE_REGISTRY` | Agent Studio 側の ECR（アカウント ID を含む） |
| `AGENT_STUDIO_URL` | 接続する Agent Studio の URL（config.yaml の `agent_studio_url` より優先） |
