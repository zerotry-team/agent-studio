# Agent Studio管理AWS Runtime

利用者が実行環境の作成画面で「Agent Studioが用意するAWS」を選ぶと、AWSアカウントIDやIAMロール名を入力せずに専用Runtimeを作成できる。

## 自動化される処理

1. APIがRuntimeと実行環境を同じDBトランザクションで作り、非同期処理をキューに入れる。
2. WorkerがAWS Organizationsで専用アカウントを作り、`Companies` OUへ移動する。
3. Workerが管理アカウントのS3 backendを使って `infra/managed-runtime` を適用する。
4. 一度だけ使えるbootstrap tokenを子アカウントのSecrets Managerへ直接保存し、Runtime Controllerを起動する。
5. RuntimeがAWS IAMの身元とtokenを使って登録すると、画面が「接続済み」になる。

処理は段階ごとにDBへ保存され、Worker再起動後も再開できる。失敗時はRuntime詳細に理由と「自動構築を再試行」を表示する。平文のbootstrap token、AWS一時認証情報、Terraform stateはControl Plane DBや画面へ返さない。

## IAM境界

- API task role: 従来のControl Plane権限だけを持つ。
- Worker task role: 従来権限に加え、管理アカウントの構築ロールを引き受けられる。
- 管理アカウントの構築ロール: Organizations操作、子アカウントの`OrganizationAccountAccessRole`引受、専用state bucket操作だけを持つ。
- Runtime: 既存の`infra/modules/tenant-runtime`が作るRuntime roleでControl Planeへ接続する。

## 初回有効化

AWSアカウント作成は取り消せないため、この初回設定は運営管理者が明示的に行う。

1. Control Planeを一度適用し、`worker_task_role_arn`を取得する。
2. Organizations管理アカウントで `infra/organization` の `runtime_provisioner_principal_arns` にそのARNを設定して適用する。
3. 出力された `runtime_provisioning_role_arn` と `managed_runtime_state_bucket` を、GitHub Environmentの変数 `MANAGED_RUNTIME_PROVISIONING_ROLE_ARN` と `MANAGED_RUNTIME_STATE_BUCKET` に設定する。
4. Control Planeを再デプロイする。

構築ロールARNが未設定の環境では、APIはStudio管理AWSの作成要求を受け付けず、既存のcustomer-owned Runtimeフローだけが動く。

## 運用確認

- Runtime詳細の進捗が `AWSアカウント作成 → AWS基盤構築 → 初回接続 → 完了` と進むこと。
- Organizationsの対象アカウントが`Companies` OUにあること。
- 子アカウントのECS serviceが安定し、Runtimeの最終応答が更新されること。
- 失敗時はCloudWatch Logs `/ecs/as-<environment>/worker` とRuntime詳細のエラーを確認し、安全な原因なら画面から再試行すること。

アカウントの閉鎖、Organizationsからの離脱、Runtime基盤の破棄はこの自動化では行わない。
