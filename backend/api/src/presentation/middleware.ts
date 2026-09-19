import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { ORGANIZATION_HEADER, memberRoleSchema, type ApiErrorBody } from "@agent-studio/contracts";
import type { Context, MiddlewareHandler } from "hono";
import { ZodError } from "zod";
import type { MemberActor, UserActor } from "../application/context.js";
import type { Deps } from "../application/deps.js";
import type { RuntimeApiService, RuntimeContext } from "../application/runtime-api.js";
import { AppError, forbidden, unauthorized } from "../domain/errors.js";

export interface AppEnv {
  Variables: {
    requestId: string;
    sourceIp: string | null;
    user: UserActor;
    member: MemberActor;
    runtime: RuntimeContext;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const requestContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = c.req.header("x-request-id") ?? randomUUID();
  c.set("requestId", requestId);
  // 監査ログ用（CloudFront → ALB を経由するため、X-Forwarded-For の先頭を記録する）
  c.set("sourceIp", c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null);
  await next();
  c.header("x-request-id", requestId);
  c.header("cache-control", "no-store");
  c.header("x-content-type-options", "nosniff");
};

function bearer(c: Context): string | null {
  const h = c.req.header("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

/** 利用者の認証（ID トークン → users） */
export function requireUser(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = bearer(c);
    if (!token) throw unauthorized();
    const identity = await deps.identity.verify(token);
    if (!identity.emailVerified) throw forbidden("メールアドレスの確認が済んでいません");
    const user = await deps.system.resolveUser(identity.subject, identity.email, identity.displayName);
    c.set("user", { userId: user.id, email: user.email, isPlatformAdmin: user.is_platform_admin, sourceIp: c.get("sourceIp") });
    await next();
  };
}

/** 組織の選択。ヘッダの組織 ID は信用せず、メンバーシップを必ず確認する（ORG-05） */
export function requireMember(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get("user");
    const organizationId = c.req.header(ORGANIZATION_HEADER);
    if (!organizationId || !UUID.test(organizationId)) {
      throw new AppError("organization_required", 400, "組織を選択してください");
    }
    const membership = await deps.db.run({ organizationId, userId: user.userId }, (tx) =>
      tx.organization_members.findUnique({
        where: { organization_id_user_id: { organization_id: organizationId, user_id: user.userId } },
        include: { organization: true },
      }),
    );
    if (!membership || membership.organization.status !== "active") throw forbidden("この組織にアクセスする権限がありません");
    c.set("member", {
      ...user,
      organizationId,
      role: memberRoleSchema.parse(membership.role),
      isApprover: membership.is_approver,
    });
    await next();
  };
}

export function requireRuntime(service: RuntimeApiService): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = bearer(c);
    if (!token) throw unauthorized("Runtime のトークンが必要です");
    c.set("runtime", await service.authenticate(token, c.get("sourceIp")));
    await next();
  };
}

/** エラーを ApiErrorBody に変換する。想定外のエラーの内容は利用者に返さない */
export function errorHandler(deps: Deps) {
  return (err: Error, c: Context<AppEnv>) => {
    let status = 500;
    let body: ApiErrorBody = { error: { code: "internal", message: "サーバーでエラーが発生しました" } };

    if (err instanceof AppError) {
      status = err.status;
      body = { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } };
    } else if (err instanceof ZodError) {
      status = 400;
      body = {
        error: {
          code: "validation_error",
          message: `入力内容に誤りがあります: ${err.issues[0]?.message ?? ""}`,
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      };
    } else if (err instanceof SyntaxError && /JSON/.test(err.message)) {
      status = 400;
      body = { error: { code: "validation_error", message: "JSON の形式が正しくありません" } };
    } else if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      status = 409;
      body = { error: { code: "conflict", message: "同じ内容のものがすでに登録されています" } };
    } else if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      status = 404;
      body = { error: { code: "not_found", message: "対象が見つかりません" } };
    }

    if (status >= 500) {
      deps.logger.error({ err, request_id: c.get("requestId"), path: c.req.path }, "リクエストの処理に失敗しました");
    }
    return c.json(body, status as 400);
  };
}
