import "server-only";
import type { ApiClient } from "@/lib/api/client";
import { getServerApiClient } from "@/lib/api/server-client";

/** リポジトリの基底クラス。API の呼び出しだけを行い、業務ロジックは持たない */
export abstract class ApiRepository {
  constructor(protected readonly api: ApiClient = getServerApiClient()) {}
}

export interface ListQuery {
  limit?: number;
  /** ISO 日時。これより前（古い）ものを返す */
  before?: string;
}
