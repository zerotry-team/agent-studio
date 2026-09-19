import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

type AlertTone = "info" | "success" | "warning" | "danger";

const styles: Record<AlertTone, { box: string; icon: string; Icon: typeof Info }> = {
  info: { box: "border-sky-200 bg-sky-50 text-sky-900", icon: "text-sky-500", Icon: Info },
  success: { box: "border-emerald-200 bg-emerald-50 text-emerald-900", icon: "text-emerald-500", Icon: CircleCheck },
  warning: { box: "border-amber-200 bg-amber-50 text-amber-900", icon: "text-amber-500", Icon: TriangleAlert },
  danger: { box: "border-red-200 bg-red-50 text-red-900", icon: "text-red-500", Icon: CircleAlert },
};

export interface AlertProps {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function Alert({ tone = "info", title, children, action, className }: AlertProps) {
  const { box, icon, Icon } = styles[tone];
  return (
    <div
      className={cn("flex gap-3 rounded-xl border px-4 py-3 text-sm", box, className)}
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", icon)} aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1 leading-relaxed">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="opacity-90">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
