import { NextRequest } from "next/server";
import { requireAuth, forbidden } from "@/lib/auth";
import { getSchedule, setSchedule, isScheduleValue } from "@/lib/backup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** دریافت برنامه پشتیبان‌گیری خودکار — فقط مدیر */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) return forbidden("پشتیبان‌گیری فقط توسط مدیر برنامه امکان‌پذیر است");
  return Response.json({ schedule: await getSchedule() });
}

/** تنظیم پشتیبان‌گیری خودکار (off/daily/weekly/monthly) — فقط مدیر */
export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) return forbidden("پشتیبان‌گیری فقط توسط مدیر برنامه امکان‌پذیر است");
  try {
    const body = (await req.json().catch(() => ({}))) as { schedule?: unknown };
    if (!isScheduleValue(body.schedule)) {
      return Response.json({ error: "مقدار زمان‌بندی نامعتبر است" }, { status: 400 });
    }
    await setSchedule(body.schedule);
    return Response.json({ schedule: body.schedule });
  } catch (e) {
    console.error("backup schedule error", e);
    return Response.json({ error: "خطا در ذخیره زمان‌بندی" }, { status: 500 });
  }
}
