"use client";

import { useState } from "react";
import { CreateOrganizationForm, type CreatedOrganization } from "@/components/admin/create-organization-form";
import { OrganizationCreatedCard } from "@/components/admin/organization-created-card";
import { Forbidden } from "@/components/common/forbidden";
import { PageHeader } from "@/components/common/page-header";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/hooks/use-session";

/** 組織の作成（運営管理者だけ。どの組織にも所属していなくても使える） */
export default function NewOrganizationPage() {
  const { can } = useSession();
  const [created, setCreated] = useState<CreatedOrganization | null>(null);

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="組織を作成"
        description="運営管理者だけが使えます。お客様の企業ごとに組織を作成し、最初のオーナーを登録します。"
        meta={can("platform.admin") ? <Badge tone="accent">運営管理者</Badge> : null}
      />
      {!can("platform.admin") ? (
        <Forbidden description="組織の作成は、Agent Studio の運営管理者だけが行えます。" />
      ) : created ? (
        <OrganizationCreatedCard
          created={created}
          onCreateAnother={() => setCreated(null)}
        />
      ) : (
        <CreateOrganizationForm onCreated={setCreated} />
      )}
    </div>
  );
}
