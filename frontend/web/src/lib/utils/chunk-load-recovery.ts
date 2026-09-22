const RELOAD_KEY = "agent-studio:chunk-reload-at";
const RELOAD_COOLDOWN_MS = 60_000;

function errorText(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  return "";
}

/** rolling deploy で旧画面が参照した versioned chunk が消えた場合だけ再読込する。 */
export function isChunkLoadFailure(value: unknown): boolean {
  const text = errorText(value);
  return /ChunkLoadError|Loading chunk [^ ]+ failed|Failed to fetch dynamically imported module/i.test(text);
}

export function installChunkLoadRecovery(now: () => number = Date.now): () => void {
  const recover = (value: unknown) => {
    if (!isChunkLoadFailure(value)) return;
    const previous = Number.parseInt(window.sessionStorage.getItem(RELOAD_KEY) ?? "0", 10);
    if (Number.isFinite(previous) && now() - previous < RELOAD_COOLDOWN_MS) return;
    window.sessionStorage.setItem(RELOAD_KEY, String(now()));
    window.location.reload();
  };
  const onError = (event: ErrorEvent) => recover(event.error ?? event.message);
  const onRejection = (event: PromiseRejectionEvent) => recover(event.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
