-- 利用者は自分の行を更新できる（RLS）が、運営管理者フラグや認証の紐づけは変えられないようにする。
-- アプリのロールには表示名の更新だけを許可する。
REVOKE UPDATE ON TABLE users FROM agent_studio_app;
GRANT UPDATE (display_name, updated_at) ON TABLE users TO agent_studio_app;

-- 組織の状態（停止など）は運営側の操作で変える。アプリからは名前だけ変えられる
REVOKE UPDATE ON TABLE organizations FROM agent_studio_app;
GRANT UPDATE (name, updated_at) ON TABLE organizations TO agent_studio_app;
