import { NextResponse } from "next/server";

/** سلامت سرویس — بدون افشای اطلاعات */
export async function GET() {
  return NextResponse.json({ ok: true, app: "VIZITO" });
}
