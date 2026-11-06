import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { requireOwnerContext, logSaAccess } from "@/lib/sa";
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
// M9: گارد یکپارچه مالک — منبع واحد در sa.ts

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const denied = requireOwnerContext(auth.ctx);
  if (denied) return denied;
  try {
    const st = await lifecycleState();
    const pausedRow = await db.setting.findUnique({ where: { key: RETENTION_PAUSED_KEY } });
    await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, null, "VIEW_LIFECYCLE", req, `phase=${st.phase}`);
    return Response.json({ ...st, pausedBySetting: pausedRow?.value === "1" });
  } catch (e) {
    console.error("lifecycle get error", e);
    return Response.json({ error: "خطا در وضعیت چرخه حیات" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const denied = requireOwnerContext(auth.ctx);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string };
    switch (body.action) {
      case "sweep": {
        // M3: ثبت حسابرسی «قبل از اجرا» (fail-closed) — sweep چندنوشتی داخلی است
        // و تراکنشی‌کردن آن با AdminAccessLog ممکن نیست؛ اجرای حذف هرگز بدون ثبت انجام نمی‌شود
        await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, null, "RETENTION_SWEEP", req, "owner-manual");
        const result = await runDataRetentionSweep("owner-manual");
        return Response.json({ ok: true, ...result });
      }
      case "pause": {
        // M3: حسابرسی توقف/ادامه حذف — قبلاً actor دور ریخته می‌شد
        await setRetentionPaused(true, { id: auth.ctx.user.id, name: auth.ctx.user.name });
        await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, null, "RETENTION_PAUSE", req);
        return Response.json({ ok: true, paused: true });
      }
      case "resume": {
        await setRetentionPaused(false, { id: auth.ctx.user.id, name: auth.ctx.user.name });
        await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, null, "RETENTION_RESUME", req);
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
