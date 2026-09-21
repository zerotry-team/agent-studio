"use server";

import type { BrowserLoginSessionDto, BrowserProfileDto, BrowserRelayTicketDto, CreateBrowserProfileInput } from "@agent-studio/contracts";
import { runAction } from "@/lib/api/run-action";
import { getServerApiClient } from "@/lib/api/server-client";

export async function listBrowserProfilesAction() {
  return runAction(() => getServerApiClient().get<BrowserProfileDto[]>("/browser-profiles"), "Browser Profileを取得できませんでした");
}

export async function createBrowserProfileAction(input: CreateBrowserProfileInput) {
  return runAction(() => getServerApiClient().post<BrowserProfileDto>("/browser-profiles", input), "Browser Profileを作成できませんでした");
}

export async function startBrowserLoginAction(profileId: string) {
  return runAction(() => getServerApiClient().post<BrowserLoginSessionDto>(`/browser-profiles/${encodeURIComponent(profileId)}/login-sessions`), "Human Loginを開始できませんでした");
}

export async function getBrowserLoginAction(sessionId: string) {
  return runAction(() => getServerApiClient().get<BrowserLoginSessionDto>(`/browser-login-sessions/${encodeURIComponent(sessionId)}`), "Human Loginの状態を取得できませんでした");
}

export async function issueBrowserRelayTicketAction(sessionId: string) {
  return runAction(() => getServerApiClient().post<BrowserRelayTicketDto>(`/browser-login-sessions/${encodeURIComponent(sessionId)}/relay-ticket`), "Human Login Relayへ接続できませんでした");
}

export async function cancelBrowserLoginAction(sessionId: string) {
  return runAction(() => getServerApiClient().post<void>(`/browser-login-sessions/${encodeURIComponent(sessionId)}/cancel`), "Human Loginを中止できませんでした");
}

export async function revokeBrowserProfileAction(profileId: string) {
  return runAction(() => getServerApiClient().delete<void>(`/browser-profiles/${encodeURIComponent(profileId)}`), "Browser Profileを無効化できませんでした");
}
