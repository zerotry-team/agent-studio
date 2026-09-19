import type { ReactNode } from "react";
import { Logo } from "@/components/layout/logo";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gray-50 px-4 py-12">
      <div className="mb-8">
        <Logo />
      </div>
      <main className="w-full max-w-sm">{children}</main>
      <p className="mt-10 text-xs text-gray-400">© Zerotry</p>
    </div>
  );
}
