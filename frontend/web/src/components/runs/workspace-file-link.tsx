"use client";

import { useState, type ReactNode } from "react";
import { listRunArtifactsAction } from "@/actions/runs";

/**
 * エージェントの作業領域（/workspace/...）を指すリンクを、保存済みの成果物に対応づける。
 * 作業領域のパスは画面から開けないため、`/workspace/outputs/` を除いた相対パスで成果物を探す。
 */
export function workspaceArtifactPath(href: string | undefined): string | null {
  if (!href) return null;
  let raw = href.trim().replace(/^sandbox:/, "").replace(/^file:\/\//, "");
  try {
    raw = decodeURI(raw);
  } catch {
    // 不正なエスケープはそのまま扱う
  }
  if (!raw.startsWith("/workspace/")) return null;
  const relative = raw.slice("/workspace/".length).replace(/^outputs\//, "").split(/[?#]/)[0] ?? "";
  if (!relative || relative.split("/").some((part) => part === ".." || part === "")) return null;
  return relative;
}

const linkClass = "break-words font-medium text-accent-700 underline decoration-accent-300 underline-offset-2 hover:text-accent-900";

/** クリックのたびに成果物一覧を取り直し、期限付きのダウンロードURLを開く */
export function WorkspaceFileLink({ runId, path, children }: { runId: string; path: string; children?: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function open() {
    setBusy(true);
    setMessage(null);
    // 非同期処理の後だとポップアップとして止められるため、先にタブを開いておく
    // noopenerを付けるとnullが返るため、開いた後でopenerを切る
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    try {
      const result = await listRunArtifactsAction(runId);
      const artifact = result.ok ? result.data.find((item) => item.path === path) : undefined;
      if (artifact?.download_url && artifact.scan_status === "passed") {
        if (tab) tab.location.href = artifact.download_url;
        else window.location.assign(artifact.download_url);
        return;
      }
      tab?.close();
      setMessage(result.ok
        ? "このファイルはまだ保存されていません。実行が終わってから、下の「作成されたファイル」を確認してください。"
        : result.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className={`${linkClass} disabled:opacity-60`} onClick={() => void open()} disabled={busy} title={path}>
        {children}
      </button>
      {message ? <span className="ml-2 text-xs text-amber-700">{message}</span> : null}
    </>
  );
}
