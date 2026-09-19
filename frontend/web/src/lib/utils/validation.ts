import type { z } from "zod";
import { zodFieldErrors } from "./zod-ja";

/** 入力の検証に失敗した（API を呼ぶ前にサーバー側で検出） */
export class InputValidationError extends Error {
  constructor(
    readonly fieldErrors: Record<string, string>,
    message = "入力内容を確認してください",
  ) {
    super(message);
    this.name = "InputValidationError";
  }
}

/** contracts の Zod スキーマで検証する。失敗したら InputValidationError */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fieldErrors = zodFieldErrors(result.error);
    const first = Object.entries(fieldErrors)[0];
    throw new InputValidationError(fieldErrors, first ? `入力内容を確認してください（${first[1]}）` : undefined);
  }
  return result.data;
}
