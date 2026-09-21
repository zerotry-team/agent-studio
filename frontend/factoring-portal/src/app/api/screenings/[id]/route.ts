import { NextResponse } from "next/server";
import { getScreening } from "@/lib/agent-studio";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
    return NextResponse.json(await getScreening(params.id));
  } catch (error) {
    console.error("[factoring-portal] screening status failed", error);
    return NextResponse.json({ message: error instanceof Error ? error.message : "審査状況を取得できませんでした" }, { status: 500 });
  }
}
