"use client";

// ブラウザ側でも Zod のメッセージを日本語にする（フォームの事前チェック用）
import "@/lib/utils/zod-ja";
import { useEffect } from "react";
import { installChunkLoadRecovery } from "@/lib/utils/chunk-load-recovery";

export function ClientInit() {
  useEffect(() => installChunkLoadRecovery(), []);
  return null;
}
