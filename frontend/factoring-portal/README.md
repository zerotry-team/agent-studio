# ClearFactor demo portal

Agent Studioで作成したファクタリング審査Agentを、申込者向けの独立画面から実行するデモです。Agent Studio管理画面とは別プロセス・別ポートで動きます。

```bash
yarn workspace @agent-studio/factoring-portal dev
```

- Portal: `http://localhost:3210`
- Agent Studio API: `http://localhost:3200`

## 承認モード

既定の`safe_auto`は、審査判定と社内記録を自動承認し、外部公開だけを自動却下します。申込者には承認画面を見せず、結果だけを返します。

```bash
DEMO_APPROVAL_MODE=safe_auto yarn workspace @agent-studio/factoring-portal dev
```

外部公開を含む全承認を通す場合は、誤設定を防ぐため二つの値を同時に指定します。

```bash
DEMO_APPROVAL_MODE=all \
DEMO_ALLOW_EXTERNAL_PUBLISH=true \
yarn workspace @agent-studio/factoring-portal dev
```

`all`は実際の外部送信を許可するため、投稿先アカウントと最終本文を確認したデモでだけ使用してください。

## 認証

ローカル開発では`dev:owner@sample-a.example`を使用します。Productionではdev tokenを拒否し、次を必須にしています。

- `AGENT_STUDIO_SERVICE_TOKEN`
- `AGENT_STUDIO_ORGANIZATION_ID`
- `AGENT_STUDIO_API_URL`（既定: `http://127.0.0.1:3200`）
