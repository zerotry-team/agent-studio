import type { BrowserAccess, CapabilityResolutionDto } from "./api.js";

/** Browser内部Toolは通常画面で個別設定させず、1つの能力として扱う。 */
export function isBrowserCapability(name: string): boolean {
  return name.startsWith("browser_") || name === "computer_action";
}

export function usesBrowserCapability(resolution: Pick<CapabilityResolutionDto, "selected_tools">): boolean {
  return resolution.selected_tools.some(isBrowserCapability);
}

/** restricted は接続先が1件以上固定されるまで未設定として扱う。 */
export function isBrowserAccessConfigured(access: BrowserAccess, allowedDomains: readonly string[]): boolean {
  return access === "public" || allowedDomains.length > 0;
}
