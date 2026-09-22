"use client";

import { Suspense } from "react";
import { PageHeader } from "@/components/common/page-header";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { CardSkeleton } from "@/components/ui/skeleton";

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="設定"
        description="組織の情報、実行・開発基盤、AIモデル、メンバーの権限、組織全体のポリシーを管理します。"
      />
      {/* ?tab= を読むため、useSearchParams を使う部分を Suspense で囲む */}
      <Suspense fallback={<CardSkeleton />}>
        <SettingsTabs />
      </Suspense>
    </>
  );
}
