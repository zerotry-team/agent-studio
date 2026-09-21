"use client";

import type { CreateBrowserProfileInput } from "@agent-studio/contracts";
import { GlobeLock, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createBrowserProfileAction, listBrowserProfilesAction, revokeBrowserProfileAction, startBrowserLoginAction } from "@/actions/browser-profiles";
import { listRuntimesAction } from "@/actions/runtimes";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";

const tone = (status: string) => status === "active" ? "success" : status === "revoked" ? "neutral" : status === "expired" ? "danger" : "warning";

export function BrowserProfilesCard() {
  const { organization, can } = useSession();
  const router = useRouter();
  const profiles = useActionQuery(() => listBrowserProfilesAction(), [organization?.id], { refetchInterval: 15_000 });
  const runtimes = useActionQuery(() => listRuntimesAction(), [organization?.id]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [domains, setDomains] = useState("");
  const [environment, setEnvironment] = useState<"staging" | "production">("staging");
  const [runtimeId, setRuntimeId] = useState("");

  const create = useActionMutation(createBrowserProfileAction, {
    successMessage: "Browser Profileを作成しました",
    onSuccess: async () => {
      setShowForm(false); setName(""); setProvider(""); setDomains("");
      await profiles.reload();
    },
  });
  const login = useActionMutation(startBrowserLoginAction, {
    onSuccess: (session) => router.push(session.launch_path),
  });
  const revoke = useActionMutation(revokeBrowserProfileAction, {
    successMessage: "Browser Profileを無効化しました",
    onSuccess: () => profiles.reload(),
  });

  const eligible = (runtimes.data ?? []).filter((runtime) => runtime.stage === environment && ["active", "degraded"].includes(runtime.status));
  const submit = () => {
    const input: CreateBrowserProfileInput = {
      ...(runtimeId ? { runtime_id: runtimeId } : {}),
      provider_key: provider.trim(),
      display_name: name.trim(),
      environment,
      allowed_domains: domains.split(",").map((value) => value.trim()).filter(Boolean),
    };
    void create.mutate(input);
  };

  return (
    <Card className="overflow-hidden xl:col-span-2">
      <CardHeader
        title={<span className="flex items-center gap-2"><GlobeLock className="h-5 w-5 text-accent-600" aria-hidden="true" />Browser Profile</span>}
        description="ログイン状態は自社Runtime内だけに暗号化保存します。パスワード、MFA、Cookie本文をAgent Studioへ保存しません。"
        actions={can("connection.manage") ? <Button size="sm" variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => setShowForm((value) => !value)}>追加</Button> : null}
      />
      <CardBody className="space-y-4">
        {showForm ? (
          <div className="grid gap-4 rounded-lg border border-gray-200 bg-gray-50 p-4 md:grid-cols-2">
            <Field label="表示名"><Input value={name} onChange={(event) => setName(event.target.value)} placeholder="取引先ポータル" /></Field>
            <Field label="Provider key"><Input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="partner_portal" autoComplete="off" /></Field>
            <Field label="環境"><Select value={environment} onChange={(event) => { setEnvironment(event.target.value as "staging" | "production"); setRuntimeId(""); }}><option value="staging">staging</option><option value="production">production</option></Select></Field>
            <Field label="Runtime"><Select value={runtimeId} onChange={(event) => setRuntimeId(event.target.value)}><option value="">自動選択</option>{eligible.map((runtime) => <option key={runtime.id} value={runtime.id}>{runtime.name}</option>)}</Select></Field>
            <div className="md:col-span-2"><Field label="許可ドメイン" hint="カンマ区切り。ログインで必要な親ドメインも明示してください。"><Input value={domains} onChange={(event) => setDomains(event.target.value)} placeholder="portal.example.com, auth.example.com" autoComplete="off" /></Field></div>
            {create.error ? <div className="md:col-span-2"><Alert tone="danger">{create.error.message}</Alert></div> : null}
            <div className="flex gap-2 md:col-span-2"><Button onClick={submit} loading={create.pending} disabled={!name.trim() || !provider.trim() || !domains.trim()}>作成</Button><Button variant="ghost" onClick={() => setShowForm(false)}>キャンセル</Button></div>
          </div>
        ) : null}
        {profiles.error ? <Alert tone="danger">Browser Profileを取得できませんでした。</Alert> : null}
        {profiles.data?.length ? <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">{profiles.data.map((profile) => (
          <div key={profile.id} className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0"><div className="flex items-center gap-2"><p className="truncate text-sm font-medium text-gray-900">{profile.display_name}</p><Badge tone={tone(profile.status)} dot>{profile.status}</Badge></div><p className="mt-1 truncate text-xs text-gray-500">{profile.environment}・{profile.allowed_domains.join(", ")}</p></div>
            <div className="flex gap-2">{profile.status !== "revoked" ? <Button size="sm" onClick={() => void login.mutate(profile.id)} loading={login.pending}>{profile.status === "active" ? "再接続" : "ログイン"}</Button> : null}{profile.status !== "revoked" ? <Button size="sm" variant="danger-outline" onClick={() => void revoke.mutate(profile.id)} loading={revoke.pending}>無効化</Button> : null}</div>
          </div>
        ))}</div> : !profiles.loading ? <p className="rounded-lg bg-gray-50 px-4 py-5 text-sm text-gray-600">Browser Profileはまだありません。ログインが必要なWebサイトをAgentで使う場合だけ追加します。</p> : null}
      </CardBody>
    </Card>
  );
}
