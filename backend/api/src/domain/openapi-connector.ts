import { createHash } from "node:crypto";
import type {
  BuilderOpenApiInput,
  BuilderOpenApiOperationDto,
  BuilderOpenApiProposalDto,
  ConnectorAuthType,
  ToolRisk,
} from "@agent-studio/contracts";
import { validationError } from "./errors.js";
import { isPrivateAddress } from "../infrastructure/http/public-url.js";

type JsonObject = Record<string, unknown>;
const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const RISK_RANK: Record<ToolRisk, number> = { read: 0, write: 1, external_send: 2, financial: 3, destructive: 4 };

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validationError(`${label}はオブジェクトで指定してください`);
  return value as JsonObject;
}

function optionalObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function localRef(root: JsonObject, ref: string, stack: Set<string>, depth: number): unknown {
  if (!ref.startsWith("#/")) throw validationError("外部$refは取り込めません。OpenAPI文書内の参照へ展開してください");
  if (depth > 16) throw validationError("OpenAPIの参照階層が深すぎます");
  if (stack.has(ref)) throw validationError(`OpenAPIに循環参照があります: ${ref}`);
  const parts = ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (parts.some((part) => part === "__proto__" || part === "constructor" || part === "prototype")) {
    throw validationError("安全でないOpenAPI参照です");
  }
  let current: unknown = root;
  for (const part of parts) current = optionalObject(current)?.[part];
  if (current === undefined) throw validationError(`OpenAPI参照が見つかりません: ${ref}`);
  return resolveRefs(root, current, new Set([...stack, ref]), depth + 1);
}

function resolveRefs(root: JsonObject, value: unknown, stack = new Set<string>(), depth = 0): unknown {
  if (depth > 16) throw validationError("OpenAPI Schemaの階層が深すぎます");
  if (Array.isArray(value)) return value.map((item) => resolveRefs(root, item, stack, depth + 1));
  const item = optionalObject(value);
  if (!item) return value;
  if (typeof item.$ref === "string") {
    const resolved = object(localRef(root, item.$ref, stack, depth), "$ref");
    const siblings = Object.fromEntries(Object.entries(item).filter(([key]) => key !== "$ref"));
    return resolveRefs(root, { ...resolved, ...siblings }, stack, depth + 1);
  }
  return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, resolveRefs(root, child, stack, depth + 1)]));
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
  return result.length >= 2 ? result : "generated-api";
}

function toolName(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(normalized) ? normalized : `operation_${normalized || "call"}`;
}

function publicBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.includes("{")) throw validationError("OpenAPI servers[0].urlには変数を含まない公開HTTPS URLが必要です");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw validationError("OpenAPI servers[0].urlが正しいURLではありません");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw validationError("OpenAPIの接続先は認証情報を含まないHTTPS URLにしてください");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || isPrivateAddress(host)) {
    throw validationError("OpenAPIの接続先に内部ネットワークのアドレスは指定できません");
  }
  return url.toString().replace(/\/$/, "");
}

function inferRisk(method: Uppercase<(typeof METHODS)[number]>, operation: JsonObject, path: string): ToolRisk {
  let risk: ToolRisk = method === "GET" ? "read" : method === "DELETE" ? "destructive" : "write";
  const text = `${operation.operationId ?? ""} ${operation.summary ?? ""} ${operation.description ?? ""} ${path}`.toLowerCase();
  const promote = (candidate: ToolRisk) => {
    if (RISK_RANK[candidate] > RISK_RANK[risk]) risk = candidate;
  };
  if (method !== "GET" && /(send|publish|post.message|email|notify|invite|share|公開|送信|通知|招待)/.test(text)) promote("external_send");
  if (method !== "GET" && /(payment|payout|charge|refund|invoice|credit|loan|price|amount|支払|決済|返金|与信|融資|金額)/.test(text)) promote("financial");
  const declared = operation["x-agent-studio-risk"];
  if (typeof declared === "string" && declared in RISK_RANK && RISK_RANK[declared as ToolRisk] > RISK_RANK[risk]) {
    risk = declared as ToolRisk;
  }
  return risk;
}

function extractAuthentication(root: JsonObject): BuilderOpenApiProposalDto["authentication"] & { authType: ConnectorAuthType } {
  const requirements: JsonObject[] = [];
  const addRequirements = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      const requirement = optionalObject(item);
      if (requirement && Object.keys(requirement).length > 0) requirements.push(requirement);
    }
  };
  addRequirements(root.security);
  const paths = optionalObject(root.paths);
  for (const pathItem of Object.values(paths ?? {})) {
    const item = optionalObject(pathItem);
    if (!item) continue;
    for (const method of METHODS) {
      const operation = optionalObject(item[method]);
      if (operation && Object.hasOwn(operation, "security")) addRequirements(operation.security);
    }
  }
  if (requirements.length === 0) return { kind: "none", header_name: null, scopes: [], requires_human_action: false, authType: "none" };
  const schemeNames = [...new Set(requirements.flatMap((requirement) => Object.keys(requirement)))];
  if (schemeNames.length !== 1) throw validationError("複数の認証方式を組み合わせるOpenAPIは自動生成できません");
  const schemeName = schemeNames[0];
  const schemes = optionalObject(optionalObject(root.components)?.securitySchemes);
  if (!schemeName || !schemes?.[schemeName]) throw validationError("OpenAPIのsecurity定義を解決できません");
  const scheme = object(resolveRefs(root, schemes[schemeName]), `securitySchemes.${schemeName}`);
  const scopes = [...new Set(requirements.flatMap((requirement) => {
    const declared = requirement[schemeName];
    return Array.isArray(declared) ? declared.filter((value): value is string => typeof value === "string") : [];
  }))];
  if (scheme.type === "apiKey") {
    if (scheme.in !== "header" || typeof scheme.name !== "string") throw validationError("API Key認証はHeader方式だけ自動生成できます");
    return { kind: "header_api_key", header_name: scheme.name, scopes, requires_human_action: true, authType: "static_bearer" };
  }
  if (scheme.type === "http" && String(scheme.scheme).toLowerCase() === "bearer") {
    return { kind: "bearer", header_name: "Authorization", scopes, requires_human_action: true, authType: "static_bearer" };
  }
  if (scheme.type === "oauth2" || scheme.type === "openIdConnect") {
    return { kind: "oauth2", header_name: "Authorization", scopes, requires_human_action: true, authType: "static_bearer" };
  }
  throw validationError(`未対応の認証方式です: ${String(scheme.type ?? "unknown")}`);
}

function schemaForOperation(root: JsonObject, pathItem: JsonObject, operation: JsonObject, method: string): { schema: JsonObject; compatible: boolean; reason?: string } {
  const properties: JsonObject = {};
  const required = new Set<string>();
  const parameters = [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
  let hasQuery = false;
  for (const raw of parameters) {
    const parameter = object(resolveRefs(root, raw), "parameter");
    if (parameter.in !== "path" && parameter.in !== "query") continue;
    if (typeof parameter.name !== "string") return { schema: {}, compatible: false, reason: "名前のないparameterがあります" };
    if (parameter.in === "query") hasQuery = true;
    properties[parameter.name] = resolveRefs(root, parameter.schema ?? { type: "string" });
    if (parameter.required === true || parameter.in === "path") required.add(parameter.name);
  }

  const requestBody = operation.requestBody ? object(resolveRefs(root, operation.requestBody), "requestBody") : undefined;
  const content = requestBody ? optionalObject(requestBody.content) : undefined;
  const jsonMedia = content ? optionalObject(content["application/json"]) : undefined;
  const bodySchema = jsonMedia?.schema ? object(resolveRefs(root, jsonMedia.schema), "requestBody schema") : undefined;
  if (bodySchema) {
    if (bodySchema.type !== "object" && !bodySchema.properties) return { schema: {}, compatible: false, reason: "JSON本文がobjectではありません" };
    if (method !== "get" && hasQuery) return { schema: {}, compatible: false, reason: "書込操作にquery parameterとJSON本文が混在しています" };
    for (const [name, value] of Object.entries(optionalObject(bodySchema.properties) ?? {})) {
      if (Object.hasOwn(properties, name)) return { schema: {}, compatible: false, reason: `入力名 ${name} がparameterと本文で重複しています` };
      properties[name] = value;
    }
    for (const name of Array.isArray(bodySchema.required) ? bodySchema.required : []) if (typeof name === "string") required.add(name);
  }

  return {
    compatible: true,
    schema: {
      type: "object",
      properties,
      ...(required.size > 0 ? { required: [...required] } : {}),
      additionalProperties: false,
    },
  };
}

function outputSchemaForOperation(root: JsonObject, operation: JsonObject): unknown {
  const responses = optionalObject(operation.responses);
  if (!responses) return undefined;
  const successKey = Object.keys(responses).sort().find((key) => /^2\d\d$/.test(key)) ?? (Object.hasOwn(responses, "default") ? "default" : undefined);
  if (!successKey) return undefined;
  const response = object(resolveRefs(root, responses[successKey]), `response ${successKey}`);
  const content = optionalObject(response.content);
  const media = content ? optionalObject(content["application/json"]) : undefined;
  return media?.schema ? resolveRefs(root, media.schema) : undefined;
}

export function inspectOpenApi(input: BuilderOpenApiInput): BuilderOpenApiProposalDto {
  const root = object(input.document, "OpenAPI");
  const version = typeof root.openapi === "string" ? root.openapi : "";
  if (!/^3\.(0|1)\./.test(version)) throw validationError("OpenAPI 3.0 または 3.1 の仕様だけ取り込めます");
  const info = object(root.info, "OpenAPI info");
  const title = typeof info.title === "string" && info.title.trim() ? info.title.trim().slice(0, 100) : "Generated API";
  const connectorKey = input.connector_key ?? slug(title);
  const connectorName = input.connector_name ?? title;
  const server = Array.isArray(root.servers) ? optionalObject(root.servers[0]) : undefined;
  const baseUrl = publicBaseUrl(server?.url);
  const authentication = extractAuthentication(root);
  const paths = object(root.paths, "OpenAPI paths");
  const operations: BuilderOpenApiOperationDto[] = [];
  const warnings: string[] = [];
  const seenNames = new Set<string>();

  for (const [path, rawPathItem] of Object.entries(paths)) {
    if (!path.startsWith("/") || path.length > 500) continue;
    const pathItem = optionalObject(rawPathItem);
    if (!pathItem) continue;
    for (const method of METHODS) {
      const operation = optionalObject(pathItem[method]);
      if (!operation) continue;
      const operationId = typeof operation.operationId === "string" && operation.operationId.trim() ? operation.operationId.trim() : `${method}_${path}`;
      const built = schemaForOperation(root, pathItem, operation, method);
      if (!built.compatible) {
        warnings.push(`${method.toUpperCase()} ${path} は未生成です: ${built.reason}`);
        continue;
      }
      const prefix = toolName(connectorKey.replace(/-/g, "_"));
      const suffix = toolName(operationId);
      let name = `${prefix}_${suffix}`.slice(0, 64).replace(/_+$/g, "");
      for (let index = 2; seenNames.has(name); index += 1) name = `${`${prefix}_${suffix}`.slice(0, 61)}_${index}`.slice(0, 64);
      seenNames.add(name);
      const upperMethod = method.toUpperCase() as Uppercase<typeof method>;
      const risk = inferRisk(upperMethod, operation, path);
      const outputSchema = outputSchemaForOperation(root, operation);
      if (method === "post") {
        const properties = built.schema.properties as JsonObject;
        if (!Object.hasOwn(properties, "idempotency_key")) {
          properties.idempotency_key = { type: "string", description: "同一処理の重複実行を防ぐ論理キー" };
        }
      }
      operations.push({
        operation_id: operationId,
        selected: input.selected_operation_ids ? input.selected_operation_ids.includes(operationId) : true,
        name,
        display_name: String(operation.summary ?? operationId).slice(0, 100),
        description: String(operation.description ?? operation.summary ?? `${upperMethod} ${path}`).slice(0, 1000),
        method: upperMethod,
        path,
        ...(method === "post" ? { idempotency_key_field: "idempotency_key" } : {}),
        risk,
        input_schema: built.schema as BuilderOpenApiOperationDto["input_schema"],
        ...(outputSchema !== undefined ? { output_schema: outputSchema } : {}),
      });
    }
  }
  if (operations.length === 0) throw validationError("安全に生成できるOpenAPI Operationがありません");
  if (!operations.some((operation) => operation.selected)) throw validationError("生成対象のOperationを1つ以上選んでください");
  const sourceUrl = input.source_url ?? (typeof root.externalDocs === "object" ? optionalObject(root.externalDocs)?.url : undefined);
  return {
    source: {
      title,
      spec_version: version,
      source_url: typeof sourceUrl === "string" && sourceUrl.startsWith("https://") ? sourceUrl : null,
      content_hash: createHash("sha256").update(canonicalJson(root)).digest("hex"),
    },
    connector: {
      key: connectorKey,
      name: connectorName,
      description: String(info.description ?? `${title}のOpenAPIから生成`).slice(0, 1000),
      adapter: "http_openapi",
      base_url: baseUrl,
      auth_type: authentication.authType,
    },
    authentication: {
      kind: authentication.kind,
      header_name: authentication.header_name,
      scopes: authentication.scopes,
      requires_human_action: authentication.requires_human_action,
    },
    operations,
    warnings,
  };
}
