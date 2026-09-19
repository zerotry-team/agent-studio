import { Bot } from "lucide-react";

export function Logo() {
  return (
    <span className="flex items-center gap-2">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-600 text-white" aria-hidden="true">
        <Bot className="h-5 w-5" />
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-gray-900">Agent Studio</span>
    </span>
  );
}
