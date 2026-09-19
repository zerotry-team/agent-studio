-- AlterTable
ALTER TABLE "approvals" ADD COLUMN     "call_id" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'runtime_gateway';

-- Worker: 終了した Run のセッションで、まだ後片付け（OpenAI セッション削除・Worker 停止）していないもの
CREATE OR REPLACE FUNCTION system_list_sessions_to_cleanup(p_limit integer)
RETURNS TABLE (session_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.organization_id
    FROM agent_sessions s
    JOIN runs r ON r.id = s.run_id
   WHERE s.ended_at IS NULL
     AND r.status IN ('completed', 'failed', 'cancelled')
   ORDER BY r.finished_at NULLS FIRST
   LIMIT p_limit
$$;

-- Worker: 実行中の Eval
CREATE OR REPLACE FUNCTION system_list_running_eval_runs(p_limit integer)
RETURNS TABLE (eval_run_id uuid, organization_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.id, e.organization_id FROM eval_runs e
   WHERE e.status = 'running'
   ORDER BY e.created_at
   LIMIT p_limit
$$;

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'system_list_sessions_to_cleanup(integer)',
    'system_list_running_eval_runs(integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO agent_studio_app', f);
  END LOOP;
END $$;
