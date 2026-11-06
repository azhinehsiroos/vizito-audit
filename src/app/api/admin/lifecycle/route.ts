import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden } from "@/lib/auth";
import { isOwnerMobile } from "@/lib/license";
import {
  lifecycleState,
  runDataRetentionSweep,
  setRetentionPaused,
  RETENTION_PAUSED_KEY,
} from "@/lib/lifecycle";

/**
 * چرخه حیات داده — فقط سازنده برنامه (مالک اصلی)
 * GET: وضعیت فاز (فعال/مهلت/آستانه حذف/حذف‌شده) + لاگ حذف + وضعیت توقف
 * POST: { action: "sweep" | "pause" | "resume" }
 *   - sweep: اجرای حذف کنترل‌شده (فقط اگر فاز SWEEP_DUE باشد و متوقف نشده باشد)
 *   - pause / resume: توقف یا ادامه حذف خودکار
 */
function guardOwner(mobile: string, isAdmin: boolean): Response | null {
  if (!isAdmin || !isOwnerMobile(mobile)) {
    return forbidden("این بخش فقط برای سازنده برنامه فعال است");
  }
  return null;
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const denied = guardOwner(auth.ctx.user.mobile, auth.ctx.isAdmin);
  if (denied) return denied;
  const st = await lifecycleState();
  const pausedRow = await db.setting.findUnique({ where: { key: RETENTION_PAUSED_KEY } });
  return Response.json({ ...st, pausedBySetting: pausedRow?.value === "1" });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const denied = guardOwner(auth.ctx.user.mobile, auth.ctx.isAdmin);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    switch (body.action) {
      case "sweep": {
        const result = await runDataRetentionSweep("owner-manual");
        return Response.json({ ok: true, ...result });
      }
      case "pause": {
        await setRetentionPaused(true, { id: auth.ctx.user.id, name: auth.ctx.user.name });
        return Response.json({ ok: true, paused: true });
      }
      case "resume": {
        await setRetentionPaused(false, { id: auth.ctx.user.id, name: auth.ctx.user.name });
        return Response.json({ ok: true, paused: false });
      }
      default:
        return Response.json({ error: "عملیات نامعتبر است" }, { status: 400 });
    }
  } catch (e) {
    console.error("lifecycle action error", e);
    return Response.json({ error: "خطا در اجرای عملیات چرخه حیات" }, { status: 500 });
  }
}
