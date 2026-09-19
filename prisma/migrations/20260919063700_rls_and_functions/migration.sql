-- =============================================================================
-- 組織の分離（SEC-01 / SEC-04）と、組織をまたぐ必要がある最小限の処理
--
-- - アプリは agent_studio_app ロールで接続する（BYPASSRLS なし・テーブル所有者ではない）
-- - リクエストごとにトランザクション内で app.organization_id / app.user_id を設定する
--   （backend/api/src/infrastructure/db/tenant-db.ts）
-- - テーブル所有者（マイグレーション用ロール）は RLS の対象外。下の SECURITY DEFINER 関数は
--   所有者の権限で動くため、組織をまたぐ処理はこの関数に閉じ込める
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_studio_app') THEN
    -- パスワードとログイン権限は db-bootstrap スクリプトが設定する
    CREATE ROLE agent_studio_app NOLOGIN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.organization_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

-- -----------------------------------------------------------------------------
-- 組織に属するテーブル: organization_id が操作中の組織と一致する行だけ
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organization_openai_settings', 'agents', 'agent_versions', 'tools', 'tool_versions',
    'connections', 'policies', 'runtimes', 'runtime_bootstrap_tokens', 'runtime_profiles',
    'deployments', 'runs', 'run_inputs', 'agent_sessions', 'run_events', 'approvals',
    'runtime_jobs', 'workflows', 'workflow_runs', 'eval_cases', 'eval_runs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org())',
      t
    );
  END LOOP;
END $$;

-- organizations: 操作中の組織と、自分が所属している組織だけ見える
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_select ON organizations FOR SELECT USING (
  id = app_current_org()
  OR EXISTS (
    SELECT 1 FROM organization_members m
    WHERE m.organization_id = organizations.id AND m.user_id = app_current_user()
  )
);
CREATE POLICY org_insert ON organizations FOR INSERT WITH CHECK (id = app_current_org());
CREATE POLICY org_update ON organizations FOR UPDATE USING (id = app_current_org()) WITH CHECK (id = app_current_org());

-- organization_members: 操作中の組織のメンバーと、自分自身の所属
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY members_select ON organization_members FOR SELECT USING (
  organization_id = app_current_org() OR user_id = app_current_user()
);
CREATE POLICY members_insert ON organization_members FOR INSERT WITH CHECK (organization_id = app_current_org());
CREATE POLICY members_update ON organization_members FOR UPDATE
  USING (organization_id = app_current_org()) WITH CHECK (organization_id = app_current_org());
CREATE POLICY members_delete ON organization_members FOR DELETE USING (organization_id = app_current_org());

-- users: 自分自身と、操作中の組織のメンバーだけ見える。作成は下の関数からのみ
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_select ON users FOR SELECT USING (
  id = app_current_user()
  OR EXISTS (
    SELECT 1 FROM organization_members m
    WHERE m.user_id = users.id AND m.organization_id = app_current_org()
  )
);
CREATE POLICY users_update ON users FOR UPDATE USING (id = app_current_user()) WITH CHECK (id = app_current_user());

-- audit_logs: 追記と自組織の閲覧のみ（組織が特定できない記録は organization_id = null）
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_select ON audit_logs FOR SELECT USING (organization_id = app_current_org());
CREATE POLICY audit_insert ON audit_logs FOR INSERT WITH CHECK (organization_id IS NOT DISTINCT FROM app_current_org());

-- -----------------------------------------------------------------------------
-- 権限
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO agent_studio_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agent_studio_app;
DO $$
BEGIN
  -- Prisma の検証用 DB（shadow database）には _prisma_migrations が無い
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON TABLE _prisma_migrations FROM agent_studio_app;
  END IF;
END $$;
REVOKE INSERT, DELETE ON TABLE users FROM agent_studio_app;
REVOKE DELETE ON TABLE organizations FROM agent_studio_app;
-- 監査ログと実行イベントは追記のみ（AUD-03）
REVOKE UPDATE, DELETE ON TABLE audit_logs FROM agent_studio_app;
REVOKE UPDATE, DELETE ON TABLE run_events FROM agent_studio_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agent_studio_app;

-- -----------------------------------------------------------------------------
-- 組織をまたぐ必要がある処理（SECURITY DEFINER）
-- 関数は既定で PUBLIC が実行できるため、必ず REVOKE してから agent_studio_app にだけ許可する
-- -----------------------------------------------------------------------------

-- ログイン時のユーザー解決。email は認証基盤で確認済み（email_verified）のものだけを渡すこと
CREATE OR REPLACE FUNCTION auth_resolve_user(p_subject text, p_email text, p_display_name text)
RETURNS SETOF users
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v users;
BEGIN
  SELECT * INTO v FROM users WHERE auth_subject = p_subject;
  IF FOUND THEN
    RETURN NEXT v;
    RETURN;
  END IF;

  -- 招待済みで、まだ一度もログインしていないユーザーに紐づける
  UPDATE users
     SET auth_subject = p_subject,
         display_name = coalesce(display_name, p_display_name),
         updated_at = now()
   WHERE email = lower(p_email) AND auth_subject IS NULL
  RETURNING * INTO v;
  IF FOUND THEN
    RETURN NEXT v;
    RETURN;
  END IF;

  INSERT INTO users (auth_subject, email, display_name)
  VALUES (p_subject, lower(p_email), p_display_name)
  RETURNING * INTO v;
  RETURN NEXT v;
END $$;

-- 招待時のユーザー解決（メールアドレスで検索し、なければ作る）。呼び出し側で管理者権限を確認すること
CREATE OR REPLACE FUNCTION invite_resolve_user(p_email text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM users WHERE email = lower(p_email);
  IF FOUND THEN
    RETURN v_id;
  END IF;
  INSERT INTO users (email) VALUES (lower(p_email)) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- AWS の身元（アカウント ID + ロール名）から Runtime を特定する（SEC-05）
CREATE OR REPLACE FUNCTION runtime_resolve_principal(p_account text, p_role text)
RETURNS TABLE (runtime_id uuid, organization_id uuid, status text, stage text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.organization_id, r.status, r.stage
    FROM runtimes r
   WHERE r.aws_account_id = p_account AND r.expected_role_name = p_role
$$;

-- Bootstrap Token を消費して Runtime を有効にする（SEC-06）。
-- トークンが有効で、かつ AWS の身元が想定と一致する場合だけ行を返す。
CREATE OR REPLACE FUNCTION runtime_consume_bootstrap_token(p_token_hash text, p_account text, p_role text)
RETURNS TABLE (runtime_id uuid, organization_id uuid, stage text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  t runtime_bootstrap_tokens;
  r runtimes;
BEGIN
  SELECT * INTO t FROM runtime_bootstrap_tokens bt
   WHERE bt.token_hash = p_token_hash AND bt.consumed_at IS NULL AND bt.expires_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT * INTO r FROM runtimes rt
   WHERE rt.id = t.runtime_id AND rt.organization_id = t.organization_id
   FOR UPDATE;
  IF NOT FOUND OR r.status = 'revoked' OR r.aws_account_id <> p_account OR r.expected_role_name <> p_role THEN
    RETURN;
  END IF;

  -- この Runtime の未使用トークンはすべて使えなくする
  UPDATE runtime_bootstrap_tokens bt SET consumed_at = now()
   WHERE bt.runtime_id = r.id AND bt.consumed_at IS NULL;
  UPDATE runtimes rt SET status = 'active', registered_at = now(), updated_at = now()
   WHERE rt.id = r.id;

  RETURN QUERY SELECT r.id, r.organization_id, r.stage;
END $$;

-- Worker: イベント受信が必要な Run を取得してリースする（二重処理を防ぐ）
CREATE OR REPLACE FUNCTION system_claim_runs(p_owner text, p_lease_seconds integer, p_limit integer)
RETURNS TABLE (run_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE runs r
     SET stream_lease_owner = p_owner,
         stream_lease_until = now() + make_interval(secs => p_lease_seconds)
   WHERE r.id IN (
     SELECT c.id FROM runs c
      WHERE c.status IN ('queued', 'provisioning', 'running', 'requires_action')
        AND (c.stream_lease_until IS NULL OR c.stream_lease_until < now())
      ORDER BY c.created_at
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
   )
  RETURNING r.id, r.organization_id
$$;

-- Worker: 期限切れの承認を expired にする
CREATE OR REPLACE FUNCTION system_expire_approvals()
RETURNS TABLE (approval_id uuid, organization_id uuid, run_id uuid, workflow_run_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE approvals a SET status = 'expired'
   WHERE a.status = 'pending' AND a.expires_at < now()
  RETURNING a.id, a.organization_id, a.run_id, a.workflow_run_id
$$;

-- Worker: ハートビートが途絶えた Runtime を offline にする（RTM-06）
CREATE OR REPLACE FUNCTION system_mark_stale_runtimes(p_offline_after_seconds integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  UPDATE runtimes SET status = 'offline', updated_at = now()
   WHERE status IN ('active', 'degraded')
     AND last_heartbeat_at < now() - make_interval(secs => p_offline_after_seconds);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Worker: リースが切れたジョブを戻す（一定回数を超えたら失敗にする）
CREATE OR REPLACE FUNCTION system_requeue_expired_jobs(p_max_attempts integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  UPDATE runtime_jobs
     SET status = CASE WHEN attempts >= p_max_attempts THEN 'failed' ELSE 'pending' END,
         error = CASE WHEN attempts >= p_max_attempts THEN 'Runtime から結果が返りませんでした' ELSE error END,
         leased_until = NULL,
         updated_at = now()
   WHERE status = 'leased' AND leased_until < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Worker: 進める必要がある Workflow の実行
CREATE OR REPLACE FUNCTION system_list_active_workflow_runs(p_limit integer)
RETURNS TABLE (workflow_run_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT w.id, w.organization_id FROM workflow_runs w
   WHERE w.status = 'running'
   ORDER BY w.updated_at
   LIMIT p_limit
$$;

-- Worker: 監査ログを S3 Object Lock に書き出す（AUD-03）
CREATE OR REPLACE FUNCTION system_export_audit_logs(p_from timestamptz, p_to timestamptz)
RETURNS SETOF audit_logs
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT * FROM audit_logs WHERE created_at >= p_from AND created_at < p_to ORDER BY created_at
$$;

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'auth_resolve_user(text, text, text)',
    'invite_resolve_user(text)',
    'runtime_resolve_principal(text, text)',
    'runtime_consume_bootstrap_token(text, text, text)',
    'system_claim_runs(text, integer, integer)',
    'system_expire_approvals()',
    'system_mark_stale_runtimes(integer)',
    'system_requeue_expired_jobs(integer)',
    'system_list_active_workflow_runs(integer)',
    'system_export_audit_logs(timestamptz, timestamptz)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO agent_studio_app', f);
  END LOOP;
END $$;
