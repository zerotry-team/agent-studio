import { Lock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";

/** 権限が足りない画面・機能 */
export function Forbidden({
  title = "この画面を表示する権限がありません",
  description = "必要な権限については、組織の管理者に問い合わせてください。",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <Card>
      <EmptyState icon={Lock} title={title} description={description} />
    </Card>
  );
}
