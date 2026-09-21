-- Browser Login Relayのuser ticketをRLSを迂回して一度だけ消費する。
-- 戻すのはrelayのroutingに必要なIDと期限だけで、Profile本文や認証情報は返さない。
CREATE OR REPLACE FUNCTION system_consume_browser_login_ticket(p_session_id uuid, p_token_hash text)
RETURNS TABLE (organization_id uuid, runtime_id uuid, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE browser_login_sessions
     -- 次のticketと一致しないランダム値へ置き換えて一度限りにする。
     -- pgcryptoのdigest()へ依存せず、既存schemaでも利用しているgen_random_uuid()だけを使う。
     SET relay_token_hash = replace(gen_random_uuid()::text, '-', '')
   WHERE id = p_session_id
     AND relay_token_hash = p_token_hash
     AND status IN ('pending', 'running')
     AND expires_at > now()
  RETURNING organization_id, runtime_id, expires_at
$$;

REVOKE ALL ON FUNCTION system_consume_browser_login_ticket(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION system_consume_browser_login_ticket(uuid, text) TO agent_studio_app;
