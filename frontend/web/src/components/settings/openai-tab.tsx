"use client";

import type { OpenAiSettingsDto } from "@agent-studio/contracts";
import { setOpenAiCredentialsSchema } from "@agent-studio/contracts";
import { Save } from "lucide-react";
import { useState, type ReactNode } from "react";
import { getOpenAiSettingsAction, updateOpenAiSettingsAction } from "@/actions/organization";
import { QueryView } from "@/components/common/query-view";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { CardSkeleton } from "@/components/ui/skeleton";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import { formatDateTime } from "@/lib/utils/format";
import { zodFieldErrors } from "@/lib/utils/zod-ja";

const DESCRIPTIONS = {
  project:
    "御社専用の OpenAI の Project です。企業ごとに Project を分けることで、ほかの企業の実行環境と混ざらないようにします。",
  appKey:
    "Agent Studio がエージェントや実行（セッション）を作成するときに使うキーです。Agent Studio の中だけに保管され、実行環境には渡しません。",
  environmentKey:
    "自社の AWS などの実行環境が OpenAI に接続するためだけに使うキーです。OpenAI のダッシュボードで、環境への接続以外の権限をすべて「なし」にして発行してください。",
} as const;

function KeyStatusBadge({ configured }: { configured: boolean }) {
  return configured ? (
    <Badge tone="success" dot>
      設定済み
    </Badge>
  ) : (
    <Badge tone="warning" dot>
      未設定
    </Badge>
  );
}

/** 左に項目の説明、右に入力欄（狭い画面では縦に並べる） */
function SettingRow({
  title,
  status,
  description,
  children,
}: {
  title: string;
  status?: ReactNode;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-4 py-5 first:pt-0 last:pb-0 md:grid-cols-5 md:gap-8">
      <div className="md:col-span-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          {status}
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-gray-500">{description}</p>
      </div>
      <div className="min-w-0 md:col-span-3">{children}</div>
    </div>
  );
}

function OpenAiSettingsForm({
  settings,
  canEdit,
  onSaved,
}: {
  settings: OpenAiSettingsDto;
  canEdit: boolean;
  onSaved: (next: OpenAiSettingsDto) => void;
}) {
  const [projectId, setProjectId] = useState(settings.openai_project_id ?? "");
  const [appKey, setAppKey] = useState("");
  const [environmentKey, setEnvironmentKey] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mutation = useActionMutation(updateOpenAiSettingsAction, {
    successMessage: "OpenAI の設定を保存しました",
    onSuccess: (next) => {
      // キーは書き込み専用。保存したら入力欄を空に戻す
      setAppKey("");
      setEnvironmentKey("");
      setProjectId(next.openai_project_id ?? "");
      onSaved(next);
    },
  });

  const error = (path: string) => errors[path] ?? mutation.fieldErrors[path];
  const missingKey = !settings.has_app_api_key || !settings.has_environment_api_key;

  const submit = async () => {
    const input = {
      openai_project_id: projectId.trim(),
      app_api_key: appKey.trim() || undefined,
      environment_api_key: environmentKey.trim() || undefined,
    };
    const parsed = setOpenAiCredentialsSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    await mutation.mutate(input);
  };

  const keyPlaceholder = (configured: boolean) => (configured ? "変更する場合だけ入力してください" : "キーを貼り付けてください");

  const body = (
    <CardBody className="space-y-4">
      {!settings.openai_project_id || missingKey ? (
        <Alert tone="warning" title="まだ設定されていない項目があります">
          Project ID と 2 つのキーがそろうまで、エージェントの実行や実行環境の準備ができない場合があります。
        </Alert>
      ) : null}
      {!canEdit ? (
        <Alert tone="info">OpenAI の設定を変更できるのはオーナーだけです。内容の確認だけができます。</Alert>
      ) : null}

      <div className="divide-y divide-gray-100">
        <SettingRow
          title="OpenAI の Project ID"
          status={settings.openai_project_id ? null : <KeyStatusBadge configured={false} />}
          description={DESCRIPTIONS.project}
        >
          {canEdit ? (
            <Field label="Project ID" required error={error("openai_project_id")}>
              <Input
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                placeholder="proj_..."
                maxLength={100}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            </Field>
          ) : (
            <div>
              <p className="text-xs font-medium text-gray-500">Project ID</p>
              <p className="mt-1 break-all font-mono text-sm text-gray-900">{settings.openai_project_id ?? "未設定"}</p>
            </div>
          )}
        </SettingRow>

        <SettingRow
          title="アプリキー"
          status={<KeyStatusBadge configured={settings.has_app_api_key} />}
          description={DESCRIPTIONS.appKey}
        >
          {canEdit ? (
            <Field
              label={settings.has_app_api_key ? "新しいアプリキー" : "アプリキー"}
              hint={settings.has_app_api_key ? "空欄のままなら、今のキーを使い続けます。保存したキーは表示されません。" : "保存したキーは、あとから表示されません。"}
              error={error("app_api_key")}
            >
              <Input
                type="password"
                autoComplete="new-password"
                value={appKey}
                onChange={(e) => setAppKey(e.target.value)}
                placeholder={keyPlaceholder(settings.has_app_api_key)}
                spellCheck={false}
                className="font-mono"
              />
            </Field>
          ) : (
            <p className="text-sm text-gray-700">{settings.has_app_api_key ? "登録されています（値は表示できません）" : "登録されていません"}</p>
          )}
        </SettingRow>

        <SettingRow
          title="環境キー"
          status={<KeyStatusBadge configured={settings.has_environment_api_key} />}
          description={DESCRIPTIONS.environmentKey}
        >
          {canEdit ? (
            <Field
              label={settings.has_environment_api_key ? "新しい環境キー" : "環境キー"}
              hint={
                settings.has_environment_api_key
                  ? "空欄のままなら、今のキーを使い続けます。保存したキーは表示されません。"
                  : "保存したキーは、あとから表示されません。"
              }
              error={error("environment_api_key")}
            >
              <Input
                type="password"
                autoComplete="new-password"
                value={environmentKey}
                onChange={(e) => setEnvironmentKey(e.target.value)}
                placeholder={keyPlaceholder(settings.has_environment_api_key)}
                spellCheck={false}
                className="font-mono"
              />
            </Field>
          ) : (
            <p className="text-sm text-gray-700">
              {settings.has_environment_api_key ? "登録されています（値は表示できません）" : "登録されていません"}
            </p>
          )}
        </SettingRow>
      </div>
    </CardBody>
  );

  const updatedAt = (
    <p className="text-xs text-gray-500 sm:mr-auto">最終更新: {formatDateTime(settings.updated_at, "まだ保存されていません")}</p>
  );

  return (
    <Card>
      <CardHeader
        title="OpenAI との連携"
        description="エージェントの実行に使う、御社専用の OpenAI の Project とキーです。キーの値は保存したあと表示されません。"
      />
      {canEdit ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          noValidate
        >
          {body}
          <CardFooter>
            {updatedAt}
            <Button type="submit" loading={mutation.pending} icon={<Save className="h-4 w-4" aria-hidden="true" />}>
              保存する
            </Button>
          </CardFooter>
        </form>
      ) : (
        <>
          {body}
          <CardFooter>{updatedAt}</CardFooter>
        </>
      )}
    </Card>
  );
}

export function OpenAiTab() {
  const { organization, can } = useSession();
  const query = useActionQuery(() => getOpenAiSettingsAction(), [organization?.id]);

  return (
    <QueryView query={query} loading={<CardSkeleton />}>
      {(settings) => <OpenAiSettingsForm settings={settings} canEdit={can("openai.edit")} onSaved={(next) => query.setData(next)} />}
    </QueryView>
  );
}
