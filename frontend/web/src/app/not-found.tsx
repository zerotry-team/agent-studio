import { FileQuestion } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-gray-100 text-gray-500" aria-hidden="true">
        <FileQuestion className="h-6 w-6" />
      </div>
      <h1 className="text-lg font-semibold text-gray-900">ページが見つかりません</h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-gray-500">
        URL が間違っているか、ページが削除された可能性があります。
      </p>
      <ButtonLink href="/" variant="primary" className="mt-6">
        ダッシュボードに戻る
      </ButtonLink>
    </div>
  );
}
