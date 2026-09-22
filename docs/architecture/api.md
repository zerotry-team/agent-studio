# Agent Studio API（フロントエンド向け）

- ベース: `/api/v1`（Web サーバーからは `API_INTERNAL_URL` 経由で呼ぶ）
- 認証: `Authorization: Bearer <Cognito の ID トークン>`（`AUTH_MODE=dev` では `Bearer dev:<email>`）
- 組織: 組織に属する操作はヘッダ `x-organization-id: <organization UUID>` が必須。サーバーは必ずメンバーシップと権限を確認する
- 型: リクエストは `@agent-studio/contracts` の `*Schema`、レスポンスは `*Dto`
- エラー: `ApiErrorBody`（`{ error: { code, message, details? } }`）。`code` は `unauthorized`(401) / `forbidden`(403) / `not_found`(404) / `validation_error`(400) / `conflict`(409) / `failed_precondition`(412) / `internal`(500)。`message` は利用者にそのまま見せてよい日本語
- 一覧は `?limit=`（既定 50、最大 200）と `?before=<ISO日時>` で新しい順に取得する

「権限」列は必要な最低ロール（viewer < operator < builder < admin < owner）。

| メソッド | パス | リクエスト | レスポンス | 権限 |
|---|---|---|---|---|
| GET | `/auth/config` | — | `{ mode, cognito: { domain, cli_client_id } \| null }`（CLI のログイン方法。秘密は含まない） | 認証不要 |
| GET | `/me` | — | `MeDto` | ログインのみ（組織ヘッダ不要） |
| POST | `/admin/organizations` | `createOrganizationSchema` | `OrganizationDto` | 運営管理者（組織ヘッダ不要） |
| GET | `/organization` | — | `OrganizationDto` | viewer |
| PATCH | `/organization` | `updateOrganizationSchema` | `OrganizationDto` | owner |
| GET | `/organization/openai` | — | `OpenAiSettingsDto` | admin |
| PUT | `/organization/openai` | `setOpenAiCredentialsSchema` | `OpenAiSettingsDto` | owner |
| GET | `/members` | — | `MemberDto[]` | viewer |
| POST | `/members` | `inviteMemberSchema` | `MemberDto` | admin |
| PATCH | `/members/:userId` | `updateMemberSchema` | `MemberDto` | admin（owner の付与・変更は owner） |
| DELETE | `/members/:userId` | — | 204 | admin |
| GET | `/policies` | — | `PolicyDto[]` | viewer |
| POST | `/policies` | `createPolicySchema` | `PolicyDto` | admin |
| PATCH | `/policies/:id` | `updatePolicySchema` | `PolicyDto` | admin |
| DELETE | `/policies/:id` | — | 204 | admin |
| POST | `/agent-projects` | `createAgentProjectSchema` | `CreateAgentProjectResultDto` | builder |
| GET | `/builder-projects` | — | `BuilderProjectDto[]` | viewer |
| POST | `/builder-projects` | `createBuilderProjectSchema` | `BuilderProjectDto` | builder（移行期間の互換API） |
| GET | `/builder-projects/:id` | — | `BuilderProjectDto` | viewer |
| POST | `/builder-projects/:id/agent` | — | `BuilderProjectDto` | builder（旧レコードのAgent backfill） |
| POST | `/builder-projects/:id/resume` | — | `BuilderProjectDto` | builder |
| POST | `/builder-projects/:id/cancel` | — | `BuilderProjectDto` | builder |
| POST | `/builder-projects/:id/openapi/inspect` | `builderOpenApiInputSchema` | `BuilderOpenApiProposalDto` | builder |
| POST | `/builder-projects/:id/openapi/apply` | `builderOpenApiInputSchema` | `ApplyBuilderOpenApiResultDto` | builder |
| POST | `/builder-projects/:id/mcp/inspect` | `builderMcpInputSchema` | `BuilderMcpProposalDto` | builder |
| POST | `/builder-projects/:id/mcp/apply` | `builderMcpInputSchema` | `ApplyBuilderMcpResultDto` | builder |
| POST | `/builder-projects/:id/self-hosted/plan` | `createRuntimeSchema` | `BuilderProjectDto` | admin |
| POST | `/builder-projects/:id/production/approve` | — | `BuilderProjectDto` | admin |
| POST | `/builder-human-actions/:id/complete` | — | `BuilderProjectDto` | Human Actionの`assignee_role`以上 |
| GET | `/connectors/catalog` | — | `ProviderCatalogEntryDto[]`（有名サービスのカタログと登録状況） | viewer |
| POST | `/connectors/catalog/:key/ensure` | — | `ConnectorDto`（登録済みなら再利用して200、新規は201） | builder |
| GET | `/connectors/:id/oauth-app` | — | `ConnectorOAuthAppDto`（Client Secretは有無だけ） | viewer |
| PUT | `/connectors/:id/oauth-app` | `setConnectorOAuthAppSchema` | `ConnectorOAuthAppDto` | owner |
| POST | `/connectors/:id/oauth/start` | `connectorOAuthStartSchema` | `ConnectorOAuthStartDto`（認可URL。stateとPKCEはフロントの封印cookieが保持） | builder |
| POST | `/connectors/:id/oauth/exchange` | `connectorOAuthExchangeSchema` | `ConnectionDto`（tokenはSecret Storeへ。成功時にBuilderの接続待ちActionを自動完了） | builder |
| POST | `/connectors/:id/qiita-oauth/exchange` | `exchangeQiitaOAuthSchema` | `ConnectionDto`（旧経路。`/oauth/exchange`の別名） | builder |
| GET | `/tools` | — | `ToolDto[]` | viewer |
| POST | `/tools` | `createToolInputSchema` | `ToolDto` | builder |
| GET | `/tools/:id` | — | `ToolDto`（`versions` 付き） | viewer |
| POST | `/tools/:id/versions` | `createToolVersionSchema` | `ToolVersionDto` | builder |
| GET | `/connections` | — | `ConnectionDto[]` | viewer |
| POST | `/connections` | `createConnectionSchema` | `ConnectionDto` | admin |
| POST | `/connections/github-app` | `createGitHubAppConnectionSchema` | `ConnectionDto`（秘密鍵・Webhook secretを返さない） | admin |
| PUT | `/connections/:id/secret` | `setConnectionSecretSchema` | 204 | admin（scope が studio / openai_vault のとき） |
| DELETE | `/connections/:id` | — | 204 | admin |
| GET | `/agents` | — | `AgentDto[]` | viewer |
| POST | `/agents` | `createAgentSchema` | `AgentDto`（`versions` 付き） | builder |
| POST | `/agents/generate` | `generateManifestSchema` | `GenerateManifestResultDto` | builder |
| POST | `/agents/validate` | `createAgentSchema` | `ManifestValidationDto` | builder |
| GET | `/agents/:id` | — | `AgentDto`（`versions` 付き） | viewer |
| GET | `/agents/:id/project` | — | `AgentProjectDto`（`build_jobs` 付き） | viewer |
| GET | `/agents/:id/build-jobs` | — | `BuilderProjectDto[]` | viewer |
| POST | `/agents/:id/versions` | `createAgentVersionSchema` | `AgentVersionDto` | builder |
| POST | `/agents/:id/versions/:version/publish` | — | `AgentVersionDto` | builder |
| GET | `/agents/:id/eval-cases` | — | `EvalCaseDto[]` | viewer |
| POST | `/agents/:id/eval-cases` | `createEvalCaseSchema` | `EvalCaseDto` | builder |
| DELETE | `/eval-cases/:id` | — | 204 | builder |
| GET | `/agents/:id/eval-runs` | — | `EvalRunDto[]` | viewer |
| POST | `/agents/:id/eval-runs` | `startEvalRunSchema` | `EvalRunDto` | builder |
| GET | `/environments` | — | `RuntimeProfileDto[]` | viewer |
| POST | `/environments` | `createRuntimeProfileSchema` | `RuntimeProfileDto` | admin |
| DELETE | `/environments/:id` | — | 204 | admin |
| GET | `/runtimes` | — | `RuntimeDto[]` | viewer |
| POST | `/runtimes` | `createRuntimeSchema` | `RuntimeDto` | admin |
| GET | `/runtimes/:id` | — | `RuntimeDto` | viewer |
| POST | `/runtimes/:id/bootstrap-tokens` | — | `BootstrapTokenDto`（平文はこの応答でのみ返す） | admin |
| POST | `/runtimes/:id/revoke` | — | `RuntimeDto` | owner |
| POST | `/runtimes/:id/rotate-environment-key` | — | 202 | admin |
| GET | `/deployments` | `?agent_id=` | `DeploymentDto[]` | viewer |
| POST | `/deployments` | `createDeploymentSchema` | `DeploymentDto` | builder（production は admin） |
| POST | `/deployments/:id/archive` | — | `DeploymentDto` | builder（production は admin） |
| GET | `/runs` | `?deployment_id=&limit=&before=` | `RunDto[]` | viewer |
| POST | `/runs` | `createRunSchema` | `RunDto` | operator |
| GET | `/runs/:id` | — | `RunDto` | viewer |
| GET | `/runs/:id/events` | `?after_seq=0` | `{ run: RunDto, events: RunEventDto[] }` | viewer |
| GET | `/runs/:id/artifacts` | — | `RunArtifactDto[]`（ダウンロード URL は5分有効） | viewer |
| POST | `/runs/:id/messages` | `sendRunMessageSchema` | 202 | operator |
| POST | `/runs/:id/cancel` | — | `RunDto` | operator |
| GET | `/approvals` | `?status=pending` | `ApprovalDto[]` | viewer |
| POST | `/approvals/:id/decision` | `approvalDecisionSchema` | `ApprovalDto` | 承認権限（`is_approver`） |
| GET | `/workflows` | — | `WorkflowDto[]` | viewer |
| POST | `/workflows` | `createWorkflowSchema` | `WorkflowDto` | builder |
| GET | `/workflows/:id` | — | `WorkflowDto` | viewer |
| PUT | `/workflows/:id` | `updateWorkflowSchema` | `WorkflowDto` | builder |
| POST | `/workflows/:id/runs` | `startWorkflowRunSchema` | `WorkflowRunDto` | operator |
| GET | `/workflow-runs` | `?workflow_id=` | `WorkflowRunDto[]` | viewer |
| GET | `/workflow-runs/:id` | — | `WorkflowRunDto` | viewer |
| GET | `/audit-logs` | `?limit=&before=` | `AuditLogDto[]` | admin |
| GET | `/usage` | `?month=YYYY-MM` | `UsageDto` | admin |

GitHub App webhookは認証不要の`POST /webhooks/github`で受けるが、`X-Hub-Signature-256`、delivery ID、repository ID allowlistを必須とする。mergeイベントはProvider APIでPR head SHAとRequired Checksを再検証する。Preview配布イベントはmerge SHA、descriptor/contract hash、OCI digest、SBOM digestのattestationをConnection固定のEd25519公開鍵で検証し、dependency/Secret scanとprovenanceも検証する。

Runtime向け`POST /runtime/v1/jobs/:id/git-credential`は、対象Runtimeへlease済みのJobに限って短期Installation tokenを返す。Tokenは永続化しない。
- `publish_builder_branch`: Connectionの権限（contents: write）で1回だけ。Runtimeはaskpassで許可repositoryの`builder/*` branchだけへpushする
- `start_session`（`builder_workspace`付き）: 読み取り専用（contents: read）。ECSではControllerがcloneしてSession Workerへ作業領域を渡す（Workerにtokenは渡さない）
- `install_adapter`: 読み取り専用。CIがGitHub Releaseへ添付したAdapter packageの取得に使う

GitHub `deployment_status` webhookの`deployment.payload.agent_studio`に`package: { release_asset_id }`があれば、署名を検証したうえで対象Runtimeへ`install_adapter` Jobを1つだけ作る（同じChange Set・digestで再送されても重ねない）。Runtimeはdigest・descriptor hash・Ed25519署名を自分でも検証してから保存し、Tool Gatewayで起動してheartbeatでToolを報告する。

Runtime向け`POST /runtime/v1/sessions/:id/artifacts`は、Tool Gatewayが`browser_download`の本文をRun Artifactとして保存するときだけ使う（Browser Worker → Tool Gateway → Controller 内部API → Agent Studio）。自分のRuntimeが持つ未終了Sessionに限り、base64本文（25MB以下）のサイズ・SHA-256を再検証し、安全検査を通ったものだけS3の`orgs/<org>/runs/<run>/browser-downloads/<artifact_id>/<filename>`へ保存する。拒否したファイルは`scan_status=rejected`の記録だけを残す。モデルへはメタデータとRun Artifact IDだけを返し、本文は返さない。

Self-hostedのSession WorkerはOpenAIのArtifacts APIからファイルを取り出せないため、`/workspace/outputs`と`/workspace/generated_images`を数秒ごとに確認し、Tool Gatewayの`PUT /session-outputs/<session_id>/<相対パス>`へ送る。Authorizationは起動時にControllerが渡すSession専用token（Session IDとMCP token hashから作る）で、このSessionの成果物の保存にしか使えない。Tool Gatewayはhashを確かめて同じ`POST /runtime/v1/sessions/:id/artifacts`（`source=session_output`）へ中継する。同じ内容は1件にまとめ、内容が変われば更新する。ターン終了直後に届くことがあるため、終了から10分以内のSessionも受け付ける。Run画面の結果に含まれる`/workspace/...`のリンクは、クリック時に成果物一覧を取り直して期限付きURLを開く。

ヘルスチェック: `GET /health`（認証なし）。

`BuilderProjectDto.releases`は、Builderが生成したAgent、Immutable Build、Preview Deployment、Preview Run、構成ハッシュとPreview受け入れ状態を返す。Projectの`completed`はPreview Runが終端になっただけでは成立せず、選択した読み取りToolの成功イベントと`outcome=succeeded`を確認した場合だけ設定する。

MCPのinspectは公開HTTPSのStreamable HTTPサーバーに対する`tools/list`だけを実行し、入力Schemaと注釈を返す。applyは再Discoveryした契約ハッシュがinspect時と一致する場合だけConnector / Tool Versionを生成する。サーバー側の操作名は`provider_operation_name`として保持し、Studio内のTool名と分離してallowlistへ使用する。Secret値はどちらのBuilder APIも受け取らない。
