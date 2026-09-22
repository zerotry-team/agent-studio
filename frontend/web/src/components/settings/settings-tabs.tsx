"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { TabPanel, Tabs } from "@/components/ui/tabs";
import { useSession } from "@/hooks/use-session";
import { InfrastructureTab } from "./infrastructure-tab";
import { MembersTab } from "./members-tab";
import { OpenAiTab } from "./openai-tab";
import { OrganizationTab } from "./organization-tab";
import { PoliciesTab } from "./policies-tab";

type SettingsTab = "organization" | "advanced" | "openai" | "members" | "policies";

const TAB_IDS: readonly SettingsTab[] = ["organization", "advanced", "openai", "members", "policies"];
/** 旧URL（?tab=infrastructure）は詳細設定へ */
const TAB_ALIASES: Record<string, SettingsTab> = { infrastructure: "advanced" };
const DEFAULT_TAB: SettingsTab = "organization";
const ID_PREFIX = "settings";

function isSettingsTab(value: string | null): value is SettingsTab {
  return value !== null && (TAB_IDS as readonly string[]).includes(value);
}

function normalizeTab(value: string | null): string | null {
  return value && TAB_ALIASES[value] ? TAB_ALIASES[value]! : value;
}

/** 設定のタブ。表示中のタブは ?tab= と同期する（再読み込み・共有しても同じタブが開く） */
export function SettingsTabs() {
  const { can } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const canViewOpenAi = can("openai.view");
  const canViewInfrastructure = can("connection.manage") || can("environment.manage");

  const urlTab = normalizeTab(searchParams.get("tab"));
  const [tab, setTab] = useState<SettingsTab>(isSettingsTab(urlTab) ? urlTab : DEFAULT_TAB);
  // サイドバーのリンクなどで URL の ?tab= が外から変わったときは、表示するタブも合わせる
  const [seenUrlTab, setSeenUrlTab] = useState(urlTab);
  if (urlTab !== seenUrlTab) {
    setSeenUrlTab(urlTab);
    setTab(isSettingsTab(urlTab) ? urlTab : DEFAULT_TAB);
  }
  // 権限が無いタブ（OpenAI）が指定された場合は、組織のタブを表示する
  const active: SettingsTab = (tab === "openai" && !canViewOpenAi) || (tab === "advanced" && !canViewInfrastructure) ? DEFAULT_TAB : tab;

  const changeTab = (next: SettingsTab) => {
    setTab(next);
    const params = new URLSearchParams(searchParams.toString());
    if (next === DEFAULT_TAB) params.delete("tab");
    else params.set("tab", next);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return (
    <>
      <Tabs
        label="設定の項目"
        idPrefix={ID_PREFIX}
        value={active}
        onChange={changeTab}
        tabs={[
          { id: "organization", label: "組織" },
          { id: "advanced", label: "詳細設定", hidden: !canViewInfrastructure },
          { id: "openai", label: "AIモデル", hidden: !canViewOpenAi },
          { id: "members", label: "メンバー" },
          { id: "policies", label: "ポリシー" },
        ]}
      />
      <TabPanel id="organization" value={active} idPrefix={ID_PREFIX}>
        <OrganizationTab />
      </TabPanel>
      {canViewInfrastructure ? (
        <TabPanel id="advanced" value={active} idPrefix={ID_PREFIX}>
          <InfrastructureTab />
        </TabPanel>
      ) : null}
      {canViewOpenAi ? (
        <TabPanel id="openai" value={active} idPrefix={ID_PREFIX}>
          <OpenAiTab />
        </TabPanel>
      ) : null}
      <TabPanel id="members" value={active} idPrefix={ID_PREFIX}>
        <MembersTab />
      </TabPanel>
      <TabPanel id="policies" value={active} idPrefix={ID_PREFIX}>
        <PoliciesTab />
      </TabPanel>
    </>
  );
}
