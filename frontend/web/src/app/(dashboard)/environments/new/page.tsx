"use client";

import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createManagedRuntimeEnvironmentAction, createRuntimeProfileAction, createSelfHostedEnvironmentAction } from "@/actions/environments";
import { listRuntimesAction } from "@/actions/runtimes";
import { Forbidden } from "@/components/common/forbidden";
import { PageHeader } from "@/components/common/page-header";
import { AwsRuntimeFields } from "@/components/environments/aws-runtime-fields";
import { EnvironmentChoiceStep } from "@/components/environments/environment-choice-step";
import { CHOICE_LABELS, EnvironmentReview } from "@/components/environments/environment-review";
import {
  initialWizardState,
  isAwsChoice,
  mapServerErrors,
  validateWizard,
  type EnvironmentChoice,
  type EnvironmentWizardState,
} from "@/components/environments/environment-wizard";
import { OpenAiEnvironmentFields } from "@/components/environments/openai-environment-fields";
import { WizardStepper } from "@/components/environments/wizard-stepper";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";

const BACK = { href: "/environments", label: "実行環境の一覧" };
const STEPS = ["実行する場所", "設定", "確認"] as const;

export default function NewEnvironmentPage() {
  const { can } = useSession();
  if (!can("environment.manage")) {
    return (
      <>
        <PageHeader title="新しい実行環境" back={BACK} />
        <Forbidden description="実行環境の作成は、管理者以上の権限を持つメンバーだけが行えます。" />
      </>
    );
  }
  return <EnvironmentWizard />;
}

function EnvironmentWizard() {
  const router = useRouter();
  const { organization } = useSession();
  const [step, setStep] = useState(0);
  const [state, setState] = useState<EnvironmentWizardState>(initialWizardState);
  const [showErrors, setShowErrors] = useState(false);
  const [choiceError, setChoiceError] = useState<string | undefined>();
  const headingRef = useRef<HTMLSpanElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const firstRender = useRef(true);

  const runtimes = useActionQuery(() => listRuntimesAction(), [organization?.id]);
  const createProfile = useActionMutation(createRuntimeProfileAction, { successMessage: "実行環境を作成しました" });
  const createSelfHosted = useActionMutation(createSelfHostedEnvironmentAction, {
    successMessage: (result) =>
      result.createdRuntime
        ? `実行環境と Runtime「${result.createdRuntime.name}」を作成しました。続けて登録用トークンを発行してください`
        : "実行環境を作成しました",
  });
  const createManaged = useActionMutation(createManagedRuntimeEnvironmentAction, {
    successMessage: "専用AWSアカウントとRuntimeの構築を開始しました",
  });
  const pending = createProfile.pending || createSelfHosted.pending || createManaged.pending;
  const submitError = createProfile.error ?? createSelfHosted.error ?? createManaged.error;

  const validation = useMemo(() => validateWizard(state), [state]);
  const errors = {
    ...createProfile.fieldErrors,
    ...mapServerErrors(createSelfHosted.fieldErrors, state),
    ...mapServerErrors(createManaged.fieldErrors, state),
    ...(showErrors ? validation.errors : {}),
  };

  // 手順が変わったら、見出しにフォーカスを移して読み上げてもらう
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const update = (patch: Partial<EnvironmentWizardState>) => {
    setState((prev) => ({ ...prev, ...patch }));
    if (createProfile.error) createProfile.reset();
    if (createSelfHosted.error) createSelfHosted.reset();
    if (createManaged.error) createManaged.reset();
  };

  const choose = (choice: EnvironmentChoice) => {
    setChoiceError(undefined);
    if (choice === state.choice) return;
    // 種類が変わったら、別の種類の Runtime を選んだままにせず、前の種類のエラーも消す
    setShowErrors(false);
    update({ choice, runtimeId: "" });
  };

  const focusFirstError = () => {
    requestAnimationFrame(() => {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  };

  const next = () => {
    if (step === 0) {
      if (!state.choice) {
        setChoiceError("どこで実行するかを選んでください");
        return;
      }
      setStep(1);
      return;
    }
    if (step === 1) {
      setShowErrors(true);
      if (!validation.submission) {
        focusFirstError();
        return;
      }
      setStep(2);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (step < 2) {
      next();
      return;
    }
    const submission = validation.submission;
    if (!submission) {
      setShowErrors(true);
      setStep(1);
      return;
    }
    if (submission.kind === "profile") {
      const res = await createProfile.mutate(submission.input);
      if (res.ok) router.push("/environments");
      else if (Object.keys(res.error.fieldErrors ?? {}).length > 0) setStep(1);
      return;
    }
    if (submission.kind === "managed") {
      const res = await createManaged.mutate(submission.input);
      if (res.ok) router.push(`/runtimes/${res.data.runtime.id}`);
      else if (Object.keys(res.error.fieldErrors ?? {}).length > 0) setStep(1);
      return;
    }
    const res = await createSelfHosted.mutate({ key: submission.key, name: submission.name, runtime: submission.runtime });
    if (res.ok) {
      router.push(res.data.createdRuntime ? `/runtimes/${res.data.createdRuntime.id}` : "/environments");
    } else if (Object.keys(res.error.fieldErrors ?? {}).length > 0) {
      setStep(1);
    }
  };

  const choice = state.choice;
  const stepTitle = step === 0 ? "実行する場所を選ぶ" : step === 1 ? "設定" : "内容を確認して作成";
  const stepDescription =
    step === 1
      ? choice
        ? `実行する場所: ${CHOICE_LABELS[choice]}`
        : undefined
      : step === 2
        ? isAwsChoice(choice) && state.runtimeMode === "new"
          ? choice === "studio_managed"
            ? "作成すると専用AWSアカウントとRuntimeの自動構築を開始し、進捗画面へ移ります。"
            : "作成すると、Runtime の画面に移ります。続けて登録用トークンを発行し、AWS 側に設定してください。"
          : "この内容で作成します。"
        : undefined;

  return (
    <>
      <PageHeader
        title="新しい実行環境"
        back={BACK}
        description="エージェントを実行する場所を設定します。作成した実行環境は、エージェントの定義やデプロイのときにキーで選びます。"
      />

      <WizardStepper steps={STEPS} current={step} className="mb-6" />

      <form ref={formRef} onSubmit={submit} noValidate>
        <Card>
          <CardHeader
            title={
              <span ref={headingRef} tabIndex={-1} className="focus:outline-none">
                {stepTitle}
              </span>
            }
            description={stepDescription}
          />
          <CardBody>
            {step === 0 ? <EnvironmentChoiceStep value={choice} onChange={choose} error={choiceError} /> : null}

            {step === 1 && choice ? (
              <div className="space-y-6">
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label="名前" required error={errors.name} hint="一覧に表示する名前です（例: 検証用・ブラウザ操作）。">
                    <Input
                      value={state.name}
                      maxLength={100}
                      onChange={(e) => update({ name: e.target.value })}
                      disabled={pending}
                      autoComplete="off"
                    />
                  </Field>
                  <Field
                    label="キー"
                    required
                    error={errors.key}
                    hint="半角英小文字・数字・ハイフン。エージェントの定義（environment.profile）から参照する名前です。"
                  >
                    <Input
                      value={state.key}
                      maxLength={63}
                      onChange={(e) => update({ key: e.target.value })}
                      placeholder={choice === "openai_hosted" ? "openai-browser" : choice === "none" ? "tools-only" : "aws-staging"}
                      className="font-mono"
                      disabled={pending}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                  </Field>
                </div>

                {choice === "openai_hosted" ? (
                  <OpenAiEnvironmentFields state={state} update={update} errors={errors} disabled={pending} />
                ) : null}

                {isAwsChoice(choice) ? (
                  <AwsRuntimeFields
                    provisioningType={choice}
                    state={state}
                    update={update}
                    errors={errors}
                    runtimes={runtimes.data}
                    runtimesFailed={!!runtimes.error}
                    disabled={pending}
                  />
                ) : null}

                {choice === "none" ? (
                  <Alert tone="info">
                    この実行環境を使うエージェントは、プログラムの実行やファイルの操作はできず、登録したツールだけを使います。
                  </Alert>
                ) : null}
              </div>
            ) : null}

            {step === 2 ? (
              <div className="space-y-5">
                {submitError ? (
                  <Alert tone="danger" title="作成できませんでした">
                    {submitError.message}
                  </Alert>
                ) : null}
                <EnvironmentReview state={state} runtimes={runtimes.data} />
              </div>
            ) : null}
          </CardBody>
          <CardFooter className="sm:justify-between">
            {step === 0 ? (
              <ButtonLink href="/environments" variant="secondary">
                キャンセル
              </ButtonLink>
            ) : (
              <Button
                variant="secondary"
                onClick={() => setStep(step - 1)}
                disabled={pending}
                icon={<ArrowLeft className="h-4 w-4" aria-hidden="true" />}
              >
                戻る
              </Button>
            )}
            {step < 2 ? (
              <Button type="submit" icon={<ArrowRight className="h-4 w-4" aria-hidden="true" />} className="flex-row-reverse">
                次へ
              </Button>
            ) : (
              <Button type="submit" loading={pending} icon={<Check className="h-4 w-4" aria-hidden="true" />}>
                作成する
              </Button>
            )}
          </CardFooter>
        </Card>
      </form>
    </>
  );
}
