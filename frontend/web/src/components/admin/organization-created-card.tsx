"use client";

import { Plus } from "lucide-react";
import { useEffect, useRef } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { DescriptionList } from "@/components/ui/description-list";
import type { CreatedOrganization } from "./create-organization-form";

const NEXT_STEPS: { title: string; description: (ownerEmail: string) => string }[] = [
  {
    title: "オーナーが Agent Studio にログインする",
    description: (email) => `${email} でログインすると、この組織を使えるようになります。`,
  },
  {
    title: "設定の「OpenAI」でキーを登録する",
    description: () => "オーナーが、この企業専用の Project ID・アプリキー・環境キーを登録します。",
  },
  {
    title: "実行環境を作成する",
    description: () => "エージェントを動かす実行環境（OpenAI の環境、または自社の AWS）を用意します。",
  },
];

/** 組織を作成したあとの表示（作成した内容と、次にすること） */
export function OrganizationCreatedCard({ created, onCreateAnother }: { created: CreatedOrganization; onCreateAnother: () => void }) {
  const { organization, ownerEmail } = created;
  const headingRef = useRef<HTMLDivElement>(null);

  // 画面が切り替わったことを読み上げで伝えるため、見出しにフォーカスを移す
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <Card>
      <div ref={headingRef} tabIndex={-1} className="focus:outline-none">
        <CardHeader title="組織を作成しました" description="内容を確認して、オーナーに連絡してください。" />
      </div>
      <CardBody className="space-y-6">
        <Alert tone="success" title={`「${organization.name}」を作成しました`}>
          最初のオーナー: {ownerEmail}
        </Alert>

        <DescriptionList
          items={[
            { label: "組織名", value: organization.name },
            { label: "組織の識別子", value: <span className="font-mono text-[13px]">{organization.slug}</span> },
            {
              label: "組織の ID",
              wide: true,
              value: (
                <span className="flex flex-wrap items-center gap-2">
                  <span className="break-all font-mono text-[13px]">{organization.id}</span>
                  <CopyButton value={organization.id} label="ID をコピー" />
                </span>
              ),
            },
          ]}
        />

        <div>
          <h3 className="text-sm font-semibold text-gray-900">次にすること</h3>
          <ol className="mt-3 space-y-3">
            {NEXT_STEPS.map((step, i) => (
              <li key={step.title} className="flex gap-3">
                <span
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-50 text-xs font-semibold text-accent-700 ring-1 ring-inset ring-accent-200"
                  aria-hidden="true"
                >
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900">{step.title}</p>
                  <p className="mt-0.5 break-words text-xs leading-relaxed text-gray-500">{step.description(ownerEmail)}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </CardBody>
      <CardFooter>
        <Button variant="secondary" onClick={onCreateAnother} icon={<Plus className="h-4 w-4" aria-hidden="true" />}>
          続けて作成する
        </Button>
      </CardFooter>
    </Card>
  );
}
