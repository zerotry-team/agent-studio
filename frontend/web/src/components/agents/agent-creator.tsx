"use client";

import { ArrowLeft, FileCode, Save, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createAgentAction, generateManifestAction } from "@/actions/agents";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { cn } from "@/lib/utils/cn";
import { CreatorStepper } from "./creator-stepper";
import { ManifestEditor, type ManifestValidationState } from "./manifest-editor";
import { buildStarterManifest, DESCRIPTION_EXAMPLE } from "./manifest-template";

const STEPS = [{ label: "業務の説明" }, { label: "定義の確認・編集" }] as const;
const DESCRIPTION_MIN = 5;
const DESCRIPTION_MAX = 4000;

/** 処理が続いている秒数（長い処理の待ち時間の表示用） */
function useElapsedSeconds(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return;
    setSeconds(0);
    const started = Date.now();
    const t = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [active]);
  return seconds;
}

function validateDescription(value: string): string | null {
  const length = value.trim().length;
  if (length < DESCRIPTION_MIN) return `${DESCRIPTION_MIN} 文字以上で入力してください`;
  if (length > DESCRIPTION_MAX) return `${DESCRIPTION_MAX} 文字以内で入力してください`;
  return null;
}

/** エージェントの作成（1. 業務の説明 → 2. 定義の確認・編集） */
export function AgentCreator() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [description, setDescription] = useState("");
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [manifest, setManifest] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [source, setSource] = useState<"generated" | "template">("template");
  const [validation, setValidation] = useState<ManifestValidationState | null>(null);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeading = useRef(false);

  const goToStep = (next: 1 | 2) => {
    focusHeading.current = true;
    setStep(next);
  };

  useEffect(() => {
    if (!focusHeading.current) return;
    focusHeading.current = false;
    headingRef.current?.focus();
  }, [step]);

  const generate = useActionMutation(generateManifestAction, {
    onSuccess: (result) => {
      setManifest(result.manifest_yaml);
      setNotes(result.notes);
      setSource("generated");
      goToStep(2);
    },
  });
  const [navigating, setNavigating] = useState(false);
  const create = useActionMutation(createAgentAction, {
    successMessage: (agent) => `エージェント「${agent.name}」を作成しました`,
    onSuccess: (agent) => {
      setNavigating(true);
      router.push(`/agents/${agent.id}`);
    },
  });
  const elapsed = useElapsedSeconds(generate.pending);

  const onGenerate = (e: FormEvent) => {
    e.preventDefault();
    if (generate.pending) return;
    const error = validateDescription(description);
    setDescriptionError(error);
    if (error) return;
    void generate.mutate({ description: description.trim() });
  };

  const startManual = () => {
    setManifest(buildStarterManifest(description));
    setNotes([]);
    setSource("template");
    create.reset();
    goToStep(2);
  };

  const onManifestChange = (value: string) => {
    setManifest(value);
    if (create.error) create.reset();
  };

  const status = validation?.status ?? "checking";
  const canSave = status !== "invalid" && status !== "empty";

  const onSave = (e: FormEvent) => {
    e.preventDefault();
    if (!canSave || create.pending || navigating) return;
    void create.mutate({ manifest });
  };

  const saveErrors = create.error
    ? Object.keys(create.fieldErrors).length > 0
      ? create.fieldErrors
      : { "": create.error.message }
    : undefined;
  const length = description.trim().length;

  return (
    <>
      <CreatorStepper steps={STEPS} current={step} />

      {step === 1 ? (
        <Card>
          <form onSubmit={onGenerate} noValidate aria-busy={generate.pending || undefined}>
            <CardBody className="space-y-5">
              <div>
                <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-gray-900 focus:outline-none">
                  エージェントにどんな仕事を任せますか？
                </h2>
                <p className="mt-1 max-w-2xl text-sm leading-relaxed text-gray-500">
                  業務の内容を、ふだんの言葉で書いてください。AI が、指示・使うツール・承認のルールをまとめた「定義」の案を作ります。作った案は、次の手順で確認・編集できます。
                </p>
              </div>

              <Field
                label="任せたい仕事の説明"
                required
                error={descriptionError ?? generate.fieldErrors.description}
                hint={
                  <span className="flex flex-col gap-1 sm:flex-row sm:justify-between sm:gap-6">
                    <span>例: {DESCRIPTION_EXAMPLE}</span>
                    <span className={cn("shrink-0 tabular-nums", length > DESCRIPTION_MAX && "font-medium text-red-600")}>
                      {length} / {DESCRIPTION_MAX} 文字
                    </span>
                  </span>
                }
              >
                <Textarea
                  rows={6}
                  value={description}
                  disabled={generate.pending}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    if (descriptionError) setDescriptionError(null);
                  }}
                  placeholder="例: 指定された商品の価格を変更する。変更の前後で価格を確認して報告する。"
                />
              </Field>

              {generate.pending ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-start gap-3 rounded-xl border border-accent-100 bg-accent-50/60 px-4 py-3 text-sm text-accent-900"
                >
                  <Spinner className="mt-0.5 h-4 w-4 text-accent-600" />
                  <div className="space-y-0.5">
                    <p className="font-medium">AI が定義を作成しています…</p>
                    <p className="text-accent-800/80">
                      2 分ほどかかることがあります。この画面を開いたままお待ちください。
                      <span className="ml-1 tabular-nums" aria-hidden="true">
                        （{elapsed} 秒）
                      </span>
                    </p>
                  </div>
                </div>
              ) : null}
            </CardBody>
            <CardFooter>
              <Button
                variant="ghost"
                onClick={startManual}
                disabled={generate.pending}
                icon={<FileCode className="h-4 w-4" aria-hidden="true" />}
                className="sm:mr-auto"
              >
                YAML を直接書く
              </Button>
              {manifest ? (
                <Button variant="secondary" onClick={() => goToStep(2)} disabled={generate.pending}>
                  編集中の定義に戻る
                </Button>
              ) : null}
              <Button type="submit" loading={generate.pending} icon={<Sparkles className="h-4 w-4" aria-hidden="true" />}>
                {generate.pending ? "作成しています…" : "定義を作成する"}
              </Button>
            </CardFooter>
          </form>
        </Card>
      ) : (
        <Card>
          <form onSubmit={onSave} noValidate>
            <CardBody className="space-y-5">
              <div>
                <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-gray-900 focus:outline-none">
                  定義を確認してください
                </h2>
                <p className="mt-1 max-w-2xl text-sm leading-relaxed text-gray-500">
                  {source === "generated"
                    ? "AI が作った案です。指示・ツール・ルールが業務に合っているかを確認し、必要なら直してから保存してください。"
                    : "ひな形をもとに、エージェントの定義を書いてください。"}
                  保存すると「下書き」のバージョン 1 になります。公開すると、デプロイに使えるようになります。
                </p>
              </div>

              {notes.length > 0 ? (
                <Alert tone="info" title="AI からの補足">
                  <ul className="list-disc space-y-0.5 pl-4">
                    {notes.map((note, i) => (
                      <li key={i}>{note}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}

              <ManifestEditor
                value={manifest}
                onChange={onManifestChange}
                onValidationChange={setValidation}
                disabled={create.pending}
                saveErrors={saveErrors}
              />
            </CardBody>
            <CardFooter>
              <Button
                variant="secondary"
                onClick={() => goToStep(1)}
                disabled={create.pending}
                icon={<ArrowLeft className="h-4 w-4" aria-hidden="true" />}
                className="sm:mr-auto"
              >
                戻る
              </Button>
              {!canSave ? <p className="text-xs text-gray-500 sm:mr-2">問題を直すと保存できます</p> : null}
              <Button
                type="submit"
                loading={create.pending || navigating}
                disabled={!canSave}
                icon={<Save className="h-4 w-4" aria-hidden="true" />}
              >
                保存する
              </Button>
            </CardFooter>
          </form>
        </Card>
      )}
    </>
  );
}
