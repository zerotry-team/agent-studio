import { NextResponse } from "next/server";
import { startScreening } from "@/lib/agent-studio";
import type { ScreeningInput } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const input = await request.json() as ScreeningInput;
    if (!input.application_id || !input.requested_amount || !input.invoice_amount) {
      return NextResponse.json({ message: "入力内容を確認してください" }, { status: 400 });
    }
    return NextResponse.json(await startScreening(input), { status: 201 });
  } catch (error) {
    console.error("[factoring-portal] screening start failed", error);
    return NextResponse.json({ message: error instanceof Error ? error.message : "審査を開始できませんでした" }, { status: 500 });
  }
}
