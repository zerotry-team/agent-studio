"use client";

import { Building2 } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useSession } from "@/hooks/use-session";

/** どの組織にも所属していないとき */
export function NoOrganization() {
  const { access, me } = useSession();
  return (
    <Card className="mx-auto max-w-xl">
      <EmptyState
        icon={Building2}
        title="所属している組織がありません"
        description={
          access.isPlatformAdmin
            ? "運営管理者として組織を作成できます。組織に参加するには、その組織の管理者に招待を依頼してください。"
            : `${me.user.email} はまだどの組織にも招待されていません。組織の管理者に招待を依頼してください。`
        }
        action={
          access.isPlatformAdmin ? (
            <ButtonLink href="/admin/organizations/new" variant="primary">
              組織を作成する
            </ButtonLink>
          ) : (
            <a href="/auth/logout" className="text-sm font-medium text-accent-700 hover:underline">
              別のアカウントでログインする
            </a>
          )
        }
      />
    </Card>
  );
}
