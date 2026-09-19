import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ClientInit } from "@/components/common/client-init";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Agent Studio", template: "%s | Agent Studio" },
  description: "業務用の AI エージェントを設計・デプロイ・実行・監査する",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <ClientInit />
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
