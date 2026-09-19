import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** 右側のボタンなど */
  actions?: ReactNode;
  /** 一覧に戻るリンク */
  back?: { href: string; label: string };
  /** タイトルの横に出すバッジなど */
  meta?: ReactNode;
}

export function PageHeader({ title, description, actions, back, meta }: PageHeaderProps) {
  return (
    <div className="mb-6 space-y-3">
      {back ? (
        <Link
          href={back.href}
          className="inline-flex items-center gap-1.5 rounded text-sm text-gray-500 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {back.label}
        </Link>
      ) : null}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="break-words text-xl font-semibold tracking-tight text-gray-900 sm:text-2xl">{title}</h1>
            {meta}
          </div>
          {description ? <div className="mt-1.5 max-w-3xl text-sm leading-relaxed text-gray-500">{description}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
