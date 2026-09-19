import "server-only";
import {
  createRuntimeProfileSchema,
  createRuntimeSchema,
  type CreateRuntimeInput,
  type RuntimeDto,
  type RuntimeProfileDto,
} from "@agent-studio/contracts";
import { ApiError } from "@/lib/api/errors";
import { RuntimeProfileRepository, RuntimeRepository } from "@/lib/repositories";
import { InputValidationError, parseInput } from "@/lib/utils/validation";

export interface CreateSelfHostedEnvironmentInput {
  /** 実行環境の設定のキー（Manifest の environment.profile で参照する） */
  key: string;
  name: string;
  runtime: { mode: "existing"; runtime_id: string } | { mode: "new"; input: CreateRuntimeInput };
}

export interface CreateSelfHostedEnvironmentResult {
  profile: RuntimeProfileDto;
  /** 新しく作った Runtime（既存の Runtime を選んだ場合は null） */
  createdRuntime: RuntimeDto | null;
}

/** Runtime の入力を検証する。項目のパスは実行環境の設定と区別するため `runtime.` を付ける */
function parseRuntimeInput(input: CreateRuntimeInput): CreateRuntimeInput {
  try {
    return parseInput(createRuntimeSchema, input);
  } catch (e) {
    if (!(e instanceof InputValidationError)) throw e;
    const fieldErrors = Object.fromEntries(Object.entries(e.fieldErrors).map(([k, v]) => [`runtime.${k}`, v]));
    throw new InputValidationError(fieldErrors, e.message);
  }
}

/**
 * AWS で実行する環境を作る。必要なら Runtime を作ってから、実行環境の設定（プロファイル）を作る。
 */
export class CreateSelfHostedEnvironmentService {
  constructor(
    private readonly runtimes = new RuntimeRepository(),
    private readonly profiles = new RuntimeProfileRepository(),
  ) {}

  async invoke(input: CreateSelfHostedEnvironmentInput): Promise<CreateSelfHostedEnvironmentResult> {
    // Runtime を作る前に、プロファイル側の入力（キー・名前）を先に検証しておく
    const placeholderId = "00000000-0000-4000-8000-000000000000";
    parseInput(createRuntimeProfileSchema, {
      type: "self_hosted",
      key: input.key,
      name: input.name,
      runtime_id: input.runtime.mode === "existing" ? input.runtime.runtime_id : placeholderId,
    });

    let createdRuntime: RuntimeDto | null = null;
    let runtimeId: string;
    if (input.runtime.mode === "new") {
      createdRuntime = await this.runtimes.create(parseRuntimeInput(input.runtime.input));
      runtimeId = createdRuntime.id;
    } else {
      runtimeId = input.runtime.runtime_id;
    }

    try {
      const profile = await this.profiles.create({
        type: "self_hosted",
        key: input.key,
        name: input.name,
        runtime_id: runtimeId,
      });
      return { profile, createdRuntime };
    } catch (e) {
      if (createdRuntime && e instanceof ApiError) {
        throw new ApiError(
          `Runtime「${createdRuntime.name}」は作成しましたが、実行環境の設定を保存できませんでした（${e.message}）。「既存の Runtime を使う」を選んで、もう一度お試しください`,
          e.status,
          e.code,
          e.details,
        );
      }
      throw e;
    }
  }
}
