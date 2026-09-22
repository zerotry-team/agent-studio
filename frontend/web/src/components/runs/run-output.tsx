import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type OutputKind = { kind: "json"; value: unknown } | { kind: "markdown"; value: string };

export function classifyRunOutput(output: string): OutputKind {
  const trimmed = output.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return { kind: "json", value: JSON.parse(trimmed) };
    } catch {
      // JSONに見えても不完全な場合は、内容を失わずMarkdownとして表示する。
    }
  }
  return { kind: "markdown", value: output };
}

function link({ href, children }: { href?: string; children?: ReactNode }) {
  return (
    <a className="break-words font-medium text-accent-700 underline decoration-accent-300 underline-offset-2 hover:text-accent-900" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

export function RunOutput({ output }: { output: string }) {
  const content = classifyRunOutput(output);

  if (content.kind === "json") {
    return (
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-gray-950">
        <div className="border-b border-white/10 px-4 py-2 text-xs font-medium uppercase tracking-wider text-gray-400">JSON</div>
        <pre className="max-h-[40rem] overflow-auto p-4 text-xs leading-6 text-gray-100 sm:text-sm">
          <code>{JSON.stringify(content.value, null, 2)}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="min-w-0 break-words text-sm leading-7 text-gray-800">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: link,
          h1: ({ children }) => <h1 className="mb-4 mt-7 border-b border-gray-200 pb-2 text-2xl font-semibold tracking-tight text-gray-950 first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-3 mt-7 text-xl font-semibold tracking-tight text-gray-950 first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 mt-6 text-base font-semibold text-gray-950 first:mt-0">{children}</h3>,
          p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-6 marker:text-gray-400">{children}</ul>,
          ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-6 marker:text-gray-500">{children}</ol>,
          li: ({ children }) => <li className="pl-1">{children}</li>,
          blockquote: ({ children }) => <blockquote className="my-4 border-l-4 border-accent-200 bg-accent-50/60 py-2 pl-4 pr-3 text-gray-700">{children}</blockquote>,
          hr: () => <hr className="my-6 border-gray-200" />,
          table: ({ children }) => <div className="my-4 overflow-x-auto rounded-lg border border-gray-200"><table className="w-full min-w-[32rem] border-collapse text-left text-sm">{children}</table></div>,
          thead: ({ children }) => <thead className="bg-gray-50 text-gray-700">{children}</thead>,
          tbody: ({ children }) => <tbody className="divide-y divide-gray-200 bg-white">{children}</tbody>,
          th: ({ children }) => <th className="border-b border-gray-200 px-3 py-2 font-semibold">{children}</th>,
          td: ({ children }) => <td className="px-3 py-2 align-top">{children}</td>,
          code: ({ className, children }) => {
            const fenced = className?.startsWith("language-");
            return fenced ? <code className={`${className ?? ""} text-gray-100`}>{children}</code> : <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[0.9em] text-gray-900">{children}</code>;
          },
          pre: ({ children }) => <pre className="my-4 max-h-[40rem] overflow-auto rounded-lg bg-gray-950 p-4 font-mono text-xs leading-6 text-gray-100 sm:text-sm">{children}</pre>,
          strong: ({ children }) => <strong className="font-semibold text-gray-950">{children}</strong>,
        }}
      >
        {content.value}
      </ReactMarkdown>
    </div>
  );
}
