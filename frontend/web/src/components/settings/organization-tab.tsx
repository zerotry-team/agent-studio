"use client";

import type { OrganizationDto } from "@agent-studio/contracts";
import { updateOrganizationSchema } from "@agent-studio/contracts";
import { Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { getOrganizationAction, updateOrganizationAction } from "@/actions/organization";
import { QueryView } from "@/components/common/query-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/card";
import { DescriptionList } from "@/components/ui/description-list";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { CardSkeleton } from "@/components/ui/skeleton";
import { useActionMutation } from "@/hooks/use-action-mutation";
import { useActionQuery } from "@/hooks/use-action-query";
import { useSession } from "@/hooks/use-session";
import { formatDateTime } from "@/lib/utils/format";
import { ORGANIZATION_STATUS_LABELS } from "@/lib/utils/labels";
import { zodFieldErrors } from "@/lib/utils/zod-ja";

function OrganizationDetails({ organization, canEdit }: { organization: OrganizationDto; canEdit: boolean }) {
  return (
    <Card>
      <CardHeader title="組織の情報" description="この組織の基本的な情報です。" />
      <CardBody>
        <DescriptionList
          items={[
            { label: "組織名", value: organization.name },
            { label: "組織の識別子", value: <span className="font-mono text-[13px]">{organization.slug}</span> },
            {
              label: "状態",
              value: (
                <Badge tone={organization.status === "active" ? "success" : "danger"} dot>
                  {ORGANIZATION_STATUS_LABELS[organization.status]}
                </Badge>
              ),
            },
            { label: "作成日", value: formatDateTime(organization.created_at) },
          ]}
        />
        {!canEdit ? <p className="mt-5 text-xs text-gray-500">組織名の変更はオーナーだけが行えます。</p> : null}
      </CardBody>
    </Card>
  );
}

function OrganizationNameForm({ organization, onSaved }: { organization: OrganizationDto; onSaved: (org: OrganizationDto) => void }) {
  const router = useRouter();
  const [name, setName] = useState(organization.name);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const mutation = useActionMutation(updateOrganizationAction, {
    successMessage: "組織名を変更しました",
    onSuccess: (org) => {
      onSaved(org);
      setName(org.name);
      // ヘッダーの組織名も新しくする
      router.refresh();
    },
  });

  const unchanged = name.trim() === organization.name;

  const submit = async () => {
    const parsed = updateOrganizationSchema.safeParse({ name });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    await mutation.mutate({ name: parsed.data.name });
  };

  return (
    <Card>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        <CardHeader title="組織名の変更" description="画面の上部や、メンバーへの表示に使われる名前です。" />
        <CardBody>
          <Field label="組織名" required error={errors.name ?? mutation.fieldErrors.name} className="max-w-md">
            <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} autoComplete="organization" />
          </Field>
        </CardBody>
        <CardFooter>
          <Button
            type="submit"
            loading={mutation.pending}
            disabled={unchanged}
            icon={<Save className="h-4 w-4" aria-hidden="true" />}
          >
            保存する
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

export function OrganizationTab() {
  const { organization, can } = useSession();
  const canEdit = can("organization.edit");
  const query = useActionQuery(() => getOrganizationAction(), [organization?.id]);

  return (
    <QueryView
      query={query}
      loading={
        <div className="space-y-6">
          <CardSkeleton />
          {canEdit ? <CardSkeleton /> : null}
        </div>
      }
    >
      {(org) => (
        <div className="space-y-6">
          <OrganizationDetails organization={org} canEdit={canEdit} />
          {canEdit ? <OrganizationNameForm key={org.id} organization={org} onSaved={(next) => query.setData(next)} /> : null}
        </div>
      )}
    </QueryView>
  );
}
