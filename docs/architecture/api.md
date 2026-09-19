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
| GET | `/tools` | — | `ToolDto[]` | viewer |
| POST | `/tools` | `createToolInputSchema` | `ToolDto` | builder |
| GET | `/tools/:id` | — | `ToolDto`（`versions` 付き） | viewer |
| POST | `/tools/:id/versions` | `createToolVersionSchema` | `ToolVersionDto` | builder |
| GET | `/connections` | — | `ConnectionDto[]` | viewer |
| POST | `/connections` | `createConnectionSchema` | `ConnectionDto` | admin |
| PUT | `/connections/:id/secret` | `setConnectionSecretSchema` | 204 | admin（scope が studio / openai_vault のとき） |
| DELETE | `/connections/:id` | — | 204 | admin |
| GET | `/agents` | — | `AgentDto[]` | viewer |
| POST | `/agents` | `createAgentSchema` | `AgentDto`（`versions` 付き） | builder |
| POST | `/agents/generate` | `generateManifestSchema` | `GenerateManifestResultDto` | builder |
| POST | `/agents/validate` | `createAgentSchema` | `ManifestValidationDto` | builder |
| GET | `/agents/:id` | — | `AgentDto`（`versions` 付き） | viewer |
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

ヘルスチェック: `GET /health`（認証なし）。
