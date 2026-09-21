import { createHash } from "node:crypto";
import type {
  BuilderMcpInput,
  BuilderMcpOperationDto,
  BuilderMcpProposalDto,
  DiscoveredMcpToolDto,
  ToolRisk,
} from "@agent-studio/contracts";
import { validationError } from "./errors.js";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function slug(value: string): string {
  const result = value
    .normalize("NFKD")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return result.length >= 2 ? result : "mcp-server";
}

function toolName(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(normalized) ? normalized : `tool_${normalized || "call"}`;
}

function localName(connectorKey: string, remoteName: string, seen: Set<string>): string {
  const prefix = toolName(connectorKey.replace(/-/g, "_")).slice(0, 24).replace(/_+$/g, "");
  const suffix = toolName(remoteName);
  const base = `${prefix}_${suffix}`.slice(0, 64).replace(/_+$/g, "");
  let candidate = base;
  for (let index = 2; seen.has(candidate); index += 1) {
    candidate = `${base.slice(0, 61).replace(/_+$/g, "")}_${index}`.slice(0, 64);
  }
  seen.add(candidate);
  return candidate;
}

function inferRisk(tool: DiscoveredMcpToolDto): ToolRisk {
  if (tool.destructive) return "destructive";
  return tool.read_only === true ? "read" : "write";
}

export function inspectMcpDiscovery(input: BuilderMcpInput, discovered: DiscoveredMcpToolDto[]): BuilderMcpProposalDto {
  if (discovered.length === 0) throw validationError("このMCPサーバーは操作を1つも公開していません");
  const url = new URL(input.server_url);
  const hostname = url.hostname.replace(/^www\./, "");
  const connectorKey = input.connector_key ?? slug(hostname.split(".")[0] ?? hostname);
  const connectorName = input.connector_name ?? `${hostname} MCP`;
  const remoteNames = new Set<string>();
  const localNames = new Set<string>();
  const warnings: string[] = [];
  const operations: BuilderMcpOperationDto[] = [];

  for (const tool of discovered) {
    const remoteName = tool.name.trim();
    if (!remoteName || remoteName.length > 128) {
      warnings.push("名前が空または128文字を超えるMCP操作は生成しませんでした");
      continue;
    }
    if (remoteNames.has(remoteName)) {
      warnings.push(`重複するMCP操作 ${remoteName} は2件目以降を生成しませんでした`);
      continue;
    }
    remoteNames.add(remoteName);
    const name = localName(connectorKey, remoteName, localNames);
    if (name !== remoteName) warnings.push(`${remoteName} はStudio内で ${name} として登録します`);
    if (tool.read_only === null && !tool.destructive) {
      warnings.push(`${remoteName} はreadOnlyHint未申告のためwriteとして扱います`);
    }
    const risk = inferRisk(tool);
    operations.push({
      remote_name: remoteName,
      selected: input.selected_tool_names ? input.selected_tool_names.includes(remoteName) : true,
      name,
      ...(name !== remoteName ? { provider_operation_name: remoteName } : {}),
      display_name: remoteName.slice(0, 100),
      description: (tool.description.trim() || `${remoteName} MCP operation`).slice(0, 1000),
      risk,
      input_schema: tool.input_schema,
      read_only: tool.read_only,
      destructive: tool.destructive,
    });
  }

  if (operations.length === 0) throw validationError("安全に生成できるMCP操作がありません");
  if (!operations.some((operation) => operation.selected)) throw validationError("生成対象のMCP操作を1つ以上選んでください");
  const authType = input.auth_type ?? "none";
  const snapshot = {
    server_url: input.server_url,
    tools: discovered.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
      read_only: tool.read_only,
      destructive: tool.destructive,
    })),
  };
  return {
    source: {
      title: connectorName,
      spec_version: "MCP",
      source_url: input.server_url,
      content_hash: createHash("sha256").update(canonicalJson(snapshot)).digest("hex"),
    },
    connector: {
      key: connectorKey,
      name: connectorName,
      description: `${hostname} のMCP Discoveryから生成`.slice(0, 1000),
      adapter: "mcp",
      base_url: input.server_url.replace(/\/$/, ""),
      auth_type: authType,
    },
    authentication: {
      kind: authType === "none" ? "none" : "bearer",
      requires_human_action: authType !== "none",
    },
    operations,
    warnings: [...new Set(warnings)],
  };
}
