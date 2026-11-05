import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden, tooMany } from "@/lib/auth";
import { dbRateLimit, dbRetryAfterSeconds } from "@/lib/rate-limit";
import { verifyPasswordSafe } from "@/lib/auth";
import {
  readRestoreSource,
  applyRestore,
  FULL_RESTORE_CONFIRM_PHRASE,
  sessionHashOf,
  type KeepSession,
} from "@/lib/restore";
import { getTokenFromRequest } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * اجرای بازیابی — مرحله دوم جریان دومرحله‌ای:
 * رمز ادمین + تایپ نام (نام مجموعه / عبارت «بازیابی کامل») ⇒ جایگزینی تراکنشی.
 * سقف نرخ سخت‌گیرانه‌تر از پیش‌نمایش — عملیات مخرب‌پذیر است.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) return forbidden("بازیابی نسخه پشتیبان فقط توسط مدیر امکان‌پذیر است");
  const key = `rs-cnf:${auth.ctx.user.id}`;
  if (!(await dbRateLimit(key, 5, 10 * 60 * 1000))) {
    return tooMany(await dbRetryAfterSeconds(key), "تلاش‌های بازیابی زیاد است — ۱۰ دقیقه دیگر دوباره تلاش کنید");
  }

  let body: { id?: unknown; file?: unknown; password?: unknown; confirmName?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "درخواست نامعتبر است" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const file = typeof body.file === "string" ? body.file : "";
  const password = typeof body.password === "string" ? body.password : "";
  const confirmName = typeof body.confirmName === "string" ? body.confirmName : "";
  if ((!id && !file) || (id && file)) {
    return Response.json({ error: "دقیقاً یکی از «شناسه نسخه» یا «فایل پشتیبان» لازم است" }, { status: 400 });
  }
  if (!password) return Response.json({ error: "رمز عبور مدیر لازم است" }, { status: 400 });

  try {
    const src = await readRestoreSource({
      id: id || undefined,
      file: file || undefined,
      ctxOrgId: auth.ctx.org ? auth.ctx.org.id : null,
      isSuperAdmin: auth.ctx.isSuperAdmin,
    });
    if ("error" in src) return src.error;
    const parsed = src.parsed;

    // ── تأیید دومرحله‌ای ۱: رمز ادمین (برابر حساب فعلی عملیات‌دهنده) ──
    const me = await db.user.findUnique({ where: { id: auth.ctx.user.id }, select: { password: true } });
    if (!(await verifyPasswordSafe(password, me?.password ?? null))) {
      return Response.json({ error: "رمز عبور درست نیست" }, { status: 400 });
    }

    // ── تأیید دومرحله‌ای ۲: تایپ نام ──
    let expectedName = FULL_RESTORE_CONFIRM_PHRASE;
    if (parsed.scope === "ORG") {
      const org = await db.org.findUnique({ where: { id: parsed.orgId as string }, select: { name: true } });
      if (!org) return Response.json({ error: "مجموعه این نسخه پشتیبان دیگر وجود ندارد" }, { status: 400 });
      expectedName = org.name;
    }
    if (confirmName.trim() !== expectedName) {
      return Response.json(
        { error: `برای تأیید، عبارت «${expectedName}» را دقیقاً وارد کنید` },
        { status: 400 }
      );
    }

    // نشست فعلی عملیات‌دهنده — ضبط قبل از بازیابی (حذف کاربران، نشست‌ها را Cascade می‌کند)
    const token = getTokenFromRequest(req);
    const keepHash = sessionHashOf(token);
    const keepSession: KeepSession | null = keepHash
      ? await db.authSession.findUnique({ where: { tokenHash: keepHash } })
      : null;

    const result = await applyRestore(parsed, {
      keepSession,
      actorId: auth.ctx.user.id,
      actorName: auth.ctx.user.name,
    });
    console.log(
      "vizito restore:",
      result.scope === "FULL" ? "FULL server" : "org",
      "restore applied by",
      auth.ctx.user.id,
      "— sessions revoked:",
      result.sessionsRevoked
    );
    return Response.json({ ok: true, scope: result.scope, restored: result.restored, sessionsRevoked: result.sessionsRevoked });
  } catch (e) {
    console.error("restore confirm error", e);
    return Response.json({ error: "بازیابی ناموفق بود — هیچ داده‌ای تغییر نکرد" }, { status: 500 });
  }
}
