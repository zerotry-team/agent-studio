"use client";

import type { AgentDto, DeploymentDto, RuntimeProfileDto, Stage } from "@agent-studio/contracts";
import { FlaskConical, Rocket, Square } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { archiveDeploymentAction, createDeploymentAction } from "@/actions/deployments";
import { listRuntimeProfilesAction } from "@/actions/environments";
import { ErrorState } from "@/components/common/error-state";
import { QueryView } from "@/components/common/query-view";
import { DeploymentStatusBadge, RuntimeStatusBadge, StageBadge } from "@/components/common/status-badges";
import { TimeAgo } from "@/components/common/time-ago";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/input";
import { RadioCards } from "@/components/ui/radio-cards";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useActionQuery, type ActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import {
  PROFILE_TYPE_LABELS,
  RUNTIME_STATUS,
  RUNTIME_STATUS_DESCRIPTIONS,
  STAGE_LABELS,
} from "@/lib/utils/labels";
import { deploymentLabel, type AgentTab } from "./deployment-select";

export interface AgentDeployProps {
  agent: AgentDto;
  deployments: ActionQuery<DeploymentDto[]>;
  memberName: (userId: string | null) => string | null;
  onGoToTab: (tab: AgentTab) => void;
}

export function AgentDeploy({ agent, deployments, memberName, onGoToTab }: AgentDeployProps) {
  const { can } = useSession();
  return (
    <div className="space-y-6">
      {can("deployment.staging") ? (
        <DeployForm agent={agent} deployments={deployments.data} onDeployed={deployments.reload} onGoToTab={onGoToTab} />
      ) : (
        <Alert tone="info">デプロイは、作成者以上の権限を持つメンバーが行えます。</Alert>
      )}
      <DeploymentList deployments={deployments} memberName={memberName} />
    </div>
  );
}

function profileOptionLabel(p: RuntimeProfileDto): string {
  if (p.type === "self_hosted" && p.runtime) {
    return `${p.name}（AWS: ${p.runtime.name}・${RUNTIME_STATUS[p.runtime.status].label}）`;
  }
  return `${p.name}（${PROFILE_TYPE_LABELS[p.type]}）`;
}

function DeployForm({
  agent,
  deployments,
  onDeployed,
  onGoToTab,
}: {
  agent: AgentDto;
  deployments: DeploymentDto[] | undefined;
  onDeployed: () => Promise<void>;
  onGoToTab: (tab: AgentTab) => void;
}) {
  const { organization, canDeployTo } = useSession();
  const canProduction = canDeployTo("production");
  const published = (agent.versions ?? []).filter((v) => v.status === "published");
  const profiles = useActionQuery(() => listRuntimeProfilesAction(), [organization?.id]);

  const [versionId, setVersionId] = useState("");
  const [profileId, setProfileId] = useState<string | null>(null);
  const [stageChoice, setStageChoice] = useState<Stage | null>(null);
  const [confirmProduction, setConfirmProduction] = useState(false);

  const deploy = useActionMutation(createDeploymentAction, {
    successMessage: (d) => `v${d.agent_version} を${STAGE_LABELS[d.stage]}にデプロイしました`,
    errorToast: false,
    onSuccess: onDeployed,
  });

  const version = published.find((v) => v.id === versionId) ?? published[0];
  const profileList = profiles.data ?? [];
  const usable = profileList.filter((p) => p.runtime?.status !== "revoked");
  // 選んでいなければ、定義にある既定の実行環境（なければ 1 件だけのとき、その実行環境）
  const defaultProfile =
    usable.find((p) => p.key === version?.manifest.environment?.profile) ?? (usable.length === 1 ? usable[0] : undefined);
  const profile = profileId === null ? defaultProfile : profileList.find((p) => p.id === profileId);

  const runtimeStage = profile?.runtime?.stage;
  // AWS の実行環境は検証用・本番のどちらか専用なので、選んでいなければ実行環境に合わせる
  const stage: Stage = stageChoice ?? (runtimeStage && canDeployTo(runtimeStage) ? runtimeStage : "staging");
  const stageMismatch = runtimeStage !== undefined && runtimeStage !== stage;
  const replacing = deployments?.find((d) => d.status === "active" && d.stage === stage);

  const selectProfile = (id: string) => {
    setProfileId(id);
    deploy.reset();
    const next = profileList.find((p) => p.id === id)?.runtime?.stage;
    if (next && canDeployTo(next)) setStageChoice(null);
  };

  const submit = async () => {
    if (!version || !profile) return false;
    const res = await deploy.mutate({ agent_version_id: version.id, runtime_profile_id: profile.id, stage });
    return res.ok;
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!version || !profile || stageMismatch || deploy.pending) return;
    if (stage === "production") setConfirmProduction(true);
    else void submit();
  };

  if (published.length === 0) {
    return (
      <Alert
        tone="info"
        title="公開したバージョンがありません"
        action={
          <Button size="sm" variant="secondary" onClick={() => onGoToTab("overview")}>
            バージョンを公開する
          </Button>
        }
      >
        デプロイできるのは、公開したバージョンだけです。「概要」タブでバージョンを公開してください。
      </Alert>
    );
  }

  return (
    <Card>
      <form onSubmit={onSubmit} noValidate>
        <CardHeader
          title="デプロイする"
          description="公開したバージョンを実行環境に置くと、エージェントを実行できるようになります。"
        />
        <CardBody className="space-y-6">
          <Field label="どのバージョンをデプロイしますか？" error={deploy.fieldErrors.agent_version_id}>
            <Select
              value={version?.id ?? ""}
              onChange={(e) => {
                setVersionId(e.target.value);
                deploy.reset();
              }}
            >
              {published.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version}
                  {v.version === agent.published_version ? "（最新の公開バージョン）" : ""}
                </option>
              ))}
            </Select>
          </Field>

          <div className="space-y-2">
            {profiles.data === undefined ? (
              profiles.error ? (
                <ErrorState compact message={profiles.error.message} onRetry={profiles.reload} retrying={profiles.refreshing} />
              ) : (
                <Field label="どこで実行しますか？">
                  <Select disabled value="">
                    <option value="">読み込み中…</option>
                  </Select>
                </Field>
              )
            ) : profileList.length === 0 ? (
              <Alert
                tone="warning"
                title="実行環境がまだありません"
                action={
                  <Link href="/environments" className="text-sm font-medium underline">
                    実行環境を作る
                  </Link>
                }
              >
                エージェントを動かす場所（OpenAI の環境や AWS など）を先に作ってください。
              </Alert>
            ) : (
              <Field
                label="どこで実行しますか？"
                error={deploy.fieldErrors.runtime_profile_id}
                hint={
                  <>
                    実行環境は{" "}
                    <Link href="/environments" className="font-medium text-accent-700 hover:underline">
                      実行環境の画面
                    </Link>{" "}
                    で作成・確認できます。
                  </>
                }
              >
                <Select value={profile?.id ?? ""} onChange={(e) => selectProfile(e.target.value)}>
                  {profile ? null : (
                    <option value="" disabled>
                      選んでください
                    </option>
                  )}
                  {profileList.map((p) => (
                    <option key={p.id} value={p.id} disabled={p.runtime?.status === "revoked"}>
                      {profileOptionLabel(p)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {profile ? <ProfileDetail profile={profile} /> : null}
          </div>

          <RadioCards<Stage>
            legend="どちらの環境にデプロイしますか？"
            description="同じ環境で稼働中のデプロイがある場合は、新しいデプロイに置き換わります。"
            columns={2}
            value={stage}
            onChange={(next) => {
              setStageChoice(next);
              deploy.reset();
            }}
            error={
              stageMismatch && runtimeStage
                ? `選んだ実行環境は${STAGE_LABELS[runtimeStage]}専用です。「${STAGE_LABELS[runtimeStage]}」を選ぶか、別の実行環境を選んでください。`
                : deploy.fieldErrors.stage
            }
            options={[
              {
                value: "staging",
                label: STAGE_LABELS.staging,
                description: "動作を確かめるための環境です。",
                icon: FlaskConical,
              },
              {
                value: "production",
                label: STAGE_LABELS.production,
                description: canProduction ? "実際の業務で使う環境です。" : "本番へのデプロイは管理者以上が行えます",
                icon: Rocket,
                disabled: !canProduction,
              },
            ]}
          />

          {replacing && !stageMismatch ? (
            <p className="text-sm text-gray-600">
              いま{STAGE_LABELS[stage]}で稼働中の「{deploymentLabel(replacing)}」は、置き換え済みになります。
            </p>
          ) : null}

          {deploy.error ? (
            <Alert tone="danger" title="デプロイできませんでした">
              {deploy.error.message}
            </Alert>
          ) : null}
        </CardBody>
        <CardFooter>
          <Button
            type="submit"
            loading={deploy.pending}
            disabled={!version || !profile || stageMismatch}
            icon={<Rocket className="h-4 w-4" aria-hidden="true" />}
          >
            {STAGE_LABELS[stage]}にデプロイする
          </Button>
        </CardFooter>
      </form>

      <ConfirmDialog
        open={confirmProduction}
        onClose={() => setConfirmProduction(false)}
        onConfirm={submit}
        tone="primary"
        title="本番にデプロイしますか？"
        description={
          version && profile
            ? `v${version.version} を「${profile.name}」で本番にデプロイします。デプロイすると、実際の業務でこのバージョンが使われます。`
            : undefined
        }
        confirmLabel="本番にデプロイする"
      />
    </Card>
  );
}

function ProfileDetail({ profile }: { profile: RuntimeProfileDto }) {
  const runtime = profile.runtime;
  return (
    <div className="rounded-lg bg-gray-50 px-3 py-2.5 text-sm text-gray-700">
      <p>
        <span className="font-mono text-xs text-gray-500">{profile.key}</span>
        <span className="mx-2 text-gray-300" aria-hidden="true">
          |
        </span>
        {PROFILE_TYPE_LABELS[profile.type]}
      </p>
      {runtime ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <span>
            Runtime: {runtime.name}（{STAGE_LABELS[runtime.stage]}用）
          </span>
          <RuntimeStatusBadge status={runtime.status} />
        </div>
      ) : null}
      {runtime && runtime.status !== "active" ? (
        <p className="mt-1 text-xs text-amber-800">{RUNTIME_STATUS_DESCRIPTIONS[runtime.status]}</p>
      ) : null}
    </div>
  );
}

function DeploymentList({
  deployments,
  memberName,
}: {
  deployments: ActionQuery<DeploymentDto[]>;
  memberName: (userId: string | null) => string | null;
}) {
  const { canDeployTo } = useSession();
  const [target, setTarget] = useState<DeploymentDto | null>(null);
  const archive = useActionMutation(archiveDeploymentAction, { successMessage: "デプロイを停止しました" });

  return (
    <Card>
      <CardHeader title="デプロイの一覧" description="稼働中のデプロイを使って、エージェントを実行できます。" />
      <QueryView
        query={deployments}
        compactError
        loading={<TableSkeleton rows={3} columns={5} />}
        isEmpty={(items) => items.length === 0}
        empty={
          <EmptyState
            icon={Rocket}
            title="まだデプロイしていません"
            description="公開したバージョンを実行環境にデプロイすると、ここに表示されます。"
          />
        }
      >
        {(items) => {
          const sorted = [...items].sort((a, b) =>
            a.status === b.status
              ? b.created_at.localeCompare(a.created_at)
              : a.status === "active"
                ? -1
                : b.status === "active"
                  ? 1
                  : b.created_at.localeCompare(a.created_at),
          );
          return (
            <Table>
              <THead>
                <tr>
                  <TH>バージョン</TH>
                  <TH>実行環境</TH>
                  <TH>環境</TH>
                  <TH>状態</TH>
                  <TH className="hidden sm:table-cell">作成</TH>
                  <TH>
                    <span className="sr-only">操作</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {sorted.map((d) => {
                  const author = memberName(d.created_by);
                  return (
                    <TR key={d.id}>
                      <TD className="font-medium tabular-nums text-gray-900">v{d.agent_version}</TD>
                      <TD className="max-w-[14rem]">
                        <span className="block truncate text-gray-900">{d.runtime_profile.name}</span>
                        <span className="block truncate text-xs text-gray-500">{PROFILE_TYPE_LABELS[d.runtime_profile.type]}</span>
                      </TD>
                      <TD>
                        <StageBadge stage={d.stage} />
                      </TD>
                      <TD>
                        <DeploymentStatusBadge status={d.status} />
                      </TD>
                      <TD className="hidden text-gray-500 sm:table-cell">
                        <TimeAgo value={d.created_at} />
                        {author ? <span className="block max-w-[10rem] truncate text-xs">{author}</span> : null}
                      </TD>
                      <TD className="text-right">
                        {d.status === "active" && canDeployTo(d.stage) ? (
                          <Button
                            size="sm"
                            variant="danger-outline"
                            icon={<Square className="h-3.5 w-3.5" aria-hidden="true" />}
                            onClick={() => setTarget(d)}
                            aria-label={`${deploymentLabel(d)} のデプロイを停止`}
                          >
                            停止
                          </Button>
                        ) : null}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          );
        }}
      </QueryView>

      <ConfirmDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        title="このデプロイを停止しますか？"
        description={
          target
            ? `「${deploymentLabel(target)}」を停止します。停止すると、このデプロイではエージェントを実行できなくなります。もう一度使うには、新しくデプロイしてください。`
            : undefined
        }
        confirmLabel="停止する"
        onConfirm={async () => {
          if (!target) return;
          const res = await archive.mutate(target.id);
          if (!res.ok) return false;
          await deployments.reload();
        }}
      />
    </Card>
  );
}
