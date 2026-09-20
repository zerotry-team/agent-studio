"use client";

import { ArrowRight, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { createAgentProjectAction } from "@/actions/agents";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { cn } from "@/lib/utils/cn";

const DESCRIPTION_MIN = 5;
const DESCRIPTION_MAX = 4000;
const EXAMPLE = "ベンチマーク投稿と自社の過去投稿を分析し、X向けの投稿案を作成して公開したい";

function useElapsedSeconds(active: boolean) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return;
    setSeconds(0);
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return seconds;
}

/** Agent版Vercelの入口。利用者は業務だけを説明し、技術Manifestは通常見ない。 */
export function AgentCreator() {
  const router = useRouter();
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const create = useActionMutation(createAgentProjectAction, {
    successMessage: (project) => `Agent「${project.agent.name}」を準備しました`,
    onSuccess: (project) => {
      setNavigating(true);
      router.push(`/agents/${project.agent.id}`);
    },
  });
  const elapsed = useElapsedSeconds(create.pending);
  const length = description.trim().length;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (create.pending) return;
    if (length < DESCRIPTION_MIN) return setError(`${DESCRIPTION_MIN}文字以上で入力してください`);
    if (length > DESCRIPTION_MAX) return setError(`${DESCRIPTION_MAX}文字以内で入力してください`);
    setError(null);
    void create.mutate({ description: description.trim() });
  };

  return (
    <Card>
      <form onSubmit={submit} noValidate aria-busy={create.pending || undefined}>
        <CardBody className="space-y-6 py-8 sm:py-10">
          <div className="mx-auto max-w-3xl text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-50 text-accent-700">
              <Sparkles className="h-6 w-6" aria-hidden="true" />
            </div>
            <h2 className="text-2xl font-semibold tracking-tight text-gray-950">どんなAgentを公開しますか？</h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-500">
              実現したい業務を書いてください。必要な連携サービスと設定だけを確認し、Previewを準備します。
            </p>
          </div>

          <div className="mx-auto max-w-3xl">
            <Field
              label="業務の説明"
              required
              error={error ?? create.fieldErrors.description}
              hint={
                <span className="flex flex-col gap-1 sm:flex-row sm:justify-between">
                  <span>例: {EXAMPLE}</span>
                  <span className={cn("tabular-nums", length > DESCRIPTION_MAX && "font-medium text-red-600")}>{length} / {DESCRIPTION_MAX}</span>
                </span>
              }
            >
              <Textarea
                rows={7}
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                  setError(null);
                  create.reset();
                }}
                disabled={create.pending || navigating}
                placeholder={EXAMPLE}
                className="text-base leading-relaxed"
                data-autofocus
              />
            </Field>
          </div>

          {create.pending ? (
            <div className="mx-auto flex max-w-3xl items-start gap-3 rounded-xl border border-accent-100 bg-accent-50/70 px-4 py-3 text-sm text-accent-950" role="status">
              <Spinner className="mt-0.5 h-4 w-4" />
              <div>
                <p className="font-medium">Agentを準備しています</p>
                <p className="mt-0.5 text-accent-800">必要な能力、Connection、承認ルールを確認しています（{elapsed}秒）</p>
              </div>
            </div>
          ) : null}
          {create.error ? <Alert tone="danger">{create.error.message}</Alert> : null}
        </CardBody>
        <CardFooter className="justify-between">
          <Link href="/tools" className="text-xs font-medium text-gray-400 hover:text-gray-600 hover:underline">
            Advanced設定
          </Link>
          <Button type="submit" loading={create.pending || navigating} icon={<ArrowRight className="h-4 w-4" aria-hidden="true" />}>
            Agentを作成
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
