import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV !== "production";
const rootEnvPath = path.join(__dirname, "../../.env");
if (isDev && existsSync(rootEnvPath)) process.loadEnvFile(rootEnvPath);

/**
 * Content-Security-Policy。
 * - Next.js の App Router はハイドレーション用のインラインスクリプトを出すため script-src に 'unsafe-inline' が必要
 * - 開発時は React Refresh のため 'unsafe-eval' と HMR 用の WebSocket を許可する
 * - 外部オリジン（Cognito）へはリダイレクト（画面遷移）で移動するだけなので connect-src / form-action は 'self' のまま
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@agent-studio/contracts"],
  experimental: {
    // モノレポのルートからトレースする（standalone に workspace のパッケージを含めるため）
    outputFileTracingRoot: path.join(__dirname, "../../"),
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
