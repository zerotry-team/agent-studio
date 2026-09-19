import { cn } from "@/lib/utils/cn";
import { prettyJson } from "@/lib/utils/format";
import { CopyButton } from "./copy-button";

export interface CodeBlockProps {
  code: string;
  /** コピーボタンを出す */
  copyable?: boolean;
  /** 暗い背景（コマンドなど） */
  dark?: boolean;
  className?: string;
  /** 読み上げ用の説明 */
  label?: string;
  maxHeight?: string;
}

export function CodeBlock({ code, copyable = false, dark = false, className, label, maxHeight = "24rem" }: CodeBlockProps) {
  return (
    <div
      className={cn(
        "group relative rounded-lg border",
        dark ? "border-gray-800 bg-gray-900 text-gray-100" : "border-gray-200 bg-gray-50 text-gray-800",
        className,
      )}
    >
      {copyable ? (
        <div className="absolute right-2 top-2">
          <CopyButton value={code} inverted={dark} />
        </div>
      ) : null}
      <pre
        className={cn("overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-[12.5px] leading-relaxed", copyable && "pr-28")}
        style={{ maxHeight }}
        aria-label={label}
        tabIndex={0}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** JSON（文字列でもオブジェクトでもよい）を整形して表示する */
export function JsonView({ value, className, maxHeight }: { value: unknown; className?: string; maxHeight?: string }) {
  return <CodeBlock code={prettyJson(value)} className={className} maxHeight={maxHeight} />;
}
