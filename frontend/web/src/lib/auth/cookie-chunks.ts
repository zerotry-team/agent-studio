/**
 * 4KB を超える Cookie を複数に分けて保存するための補助関数。
 * Cognito の ID トークンとリフレッシュトークンを暗号化すると 4KB を超えることがあるため。
 */
export const COOKIE_CHUNK_SIZE = 3800;

export function chunkName(base: string, index: number): string {
  return `${base}.${index}`;
}

export function splitIntoChunks(value: string, size: number = COOKIE_CHUNK_SIZE): string[] {
  if (size <= 0) throw new Error("size must be positive");
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += size) chunks.push(value.slice(i, i + size));
  return chunks.length > 0 ? chunks : [""];
}

/** `${base}.0`, `${base}.1`… を連番で結合する。`.0` が無ければ null */
export function joinChunks(base: string, get: (name: string) => string | undefined): string | null {
  let result = "";
  for (let i = 0; ; i++) {
    const part = get(chunkName(base, i));
    if (part === undefined) break;
    result += part;
  }
  return result.length > 0 ? result : null;
}

/** 既存の Cookie 名のうち、このベース名の分割 Cookie に当たるもの */
export function existingChunkNames(base: string, names: Iterable<string>): string[] {
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(\\d+)$`);
  return Array.from(names).filter((n) => pattern.test(n));
}
