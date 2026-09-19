"use client";

import type { OrganizationDto } from "@agent-studio/contracts";
import { createOrganizationSchema } from "@agent-studio/contracts";
import { Building2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createOrganizationAction } from "@/actions/organization";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useSession } from "@/hooks/use-session";
import { zodFieldErrors } from "@/lib/utils/zod-ja";

export interface CreatedOrganization {
  organization: OrganizationDto;
  ownerEmail: string;
}

interface FormState {
  name: string;
  slug: string;
  ownerEmail: string;
  openaiProjectId: string;
}

const EMPTY: FormState = { name: "", slug: "", ownerEmail: "", openaiProjectId: "" };

/** 組織を作成するフォーム（運営管理者だけが使う） */
export function CreateOrganizationForm({ onCreated }: { onCreated: (created: CreatedOrganization) => void }) {
  const router = useRouter();
  const { me } = useSession();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mutation = useActionMutation(createOrganizationAction, {
    successMessage: (org) => `組織「${org.name}」を作成しました`,
  });

  const set = (key: keyof FormState, value: string) => setForm((prev) => ({ ...prev, [key]: value }));
  const error = (path: string) => errors[path] ?? mutation.fieldErrors[path];

  const submit = async () => {
    const input = {
      name: form.name.trim(),
      slug: form.slug.trim(),
      owner_email: form.ownerEmail.trim(),
      openai_project_id: form.openaiProjectId.trim() || undefined,
    };
    const parsed = createOrganizationSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    const res = await mutation.mutate(parsed.data);
    if (!res.ok) return;
    // 自分をオーナーにした場合は、組織の切り替えに新しい組織が出るように読み込み直す
    if (input.owner_email.toLowerCase() === me.user.email.toLowerCase()) router.refresh();
    onCreated({ organization: res.data, ownerEmail: input.owner_email });
  };

  return (
    <Card>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <CardHeader title="新しい組織" description="お客様の企業ごとに 1 つ作成します。作成すると、最初のオーナーがこの組織を使えるようになります。" />
        <CardBody className="space-y-5">
          <Field label="組織名" required error={error("name")} hint="画面に表示される名前です。あとから変更できます（例: 株式会社サンプル）。">
            <Input value={form.name} maxLength={100} onChange={(e) => set("name", e.target.value)} autoComplete="off" />
          </Field>
          <Field
            label="組織の識別子"
            required
            error={error("slug")}
            hint="URL などに使う半角英小文字・数字・ハイフン。あとから変更できません（例: sample-corp）。"
          >
            <Input
              value={form.slug}
              maxLength={63}
              onChange={(e) => set("slug", e.target.value.toLowerCase())}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono"
            />
          </Field>
          <Field
            label="最初のオーナーのメールアドレス"
            required
            error={error("owner_email")}
            hint="この方がオーナーになり、メンバーの招待や OpenAI のキーの登録を行います。"
          >
            <Input
              type="email"
              value={form.ownerEmail}
              onChange={(e) => set("ownerEmail", e.target.value)}
              autoComplete="off"
              placeholder="owner@example.com"
            />
          </Field>
          <Field
            label="OpenAI の Project ID"
            optional
            error={error("openai_project_id")}
            hint="この企業専用の OpenAI の Project です。企業ごとに Project を分けることで、ほかの企業の実行環境と混ざらないようにします。あとから設定の「OpenAI」でも登録できます。"
          >
            <Input
              value={form.openaiProjectId}
              maxLength={100}
              onChange={(e) => set("openaiProjectId", e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="proj_..."
              className="font-mono"
            />
          </Field>
        </CardBody>
        <CardFooter>
          <Button type="submit" loading={mutation.pending} icon={<Building2 className="h-4 w-4" aria-hidden="true" />}>
            組織を作成する
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
