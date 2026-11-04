import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden, tooMany, verifyPassword } from "@/lib/auth";
import { rateLimit, retryAfterSeconds, getClientIp } from "@/lib/rate-limit";
import { deleteAllBackups } from "@/lib/backup";
import { isOwnerMobile } from "@/lib/license";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * پاک‌سازی کامل برنامه (آماده‌سازی خروجی نهایی / انتقال به مشتری) — فقط سازنده (مالک)
 * - همه داده‌های تجاری (مشتریان، کالاها، گروه‌ها، سفارشات، پرداخت‌ها)، همه کاربرانِ
 *   «غیرِ مالک»، پیام‌ها، دفتر فروش لایسنس، تنظیمات و همه نسخه‌های پشتیبان حذف می‌شوند.
 * - حساب‌های مالک (OWNER_MOBILES) همیشه حفظ می‌شوند — مطابق سیاست کل برنامه،
 *   هیچ مسیری اجازه حذف حساب سازنده را ندارد.
 * - برای تحویل «کاملاً تازه» به مشتری، سازنده پس از پاک‌سازی متغیرهای
 *   OWNER_MOBILES/OWNER_SETUP_KEY را از env حذف می‌کند؛ اولین ثبت‌نام بعدی (نصب خالی)
 *   با SETUP_TOKEN مدیر می‌شود — همان مسیر امن راه‌اندازی اولیه.
 * - امنیت: رمز عبور سازنده الزامی است + محدودیت نرخ + ثبت تاریخ عملیات در Setting
 *   + هیچ پاسخی شامل داده حذف‌شده نیست.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) return forbidden("پاک‌سازی کامل فقط توسط مدیر برنامه امکان‌پذیر است");
  // امنیت (ممیزی v1.1.2): مخرب‌ترین عملیات برنامه فقط با حساب سازنده ممکن است —
  // مدیرِ غیرمالک هرگز نباید بتواند حساب سازنده، حساب‌ها یا دفتر فروش را از بین ببرد
  if (!isOwnerMobile(auth.ctx.user.mobile)) {
    return forbidden("پاک‌سازی کامل فقط توسط سازندهٔ برنامه امکان‌پذیر است");
  }

  const uid = auth.ctx.user.id;
  const key = `rst:${uid}:${getClientIp(req)}`;
  if (!rateLimit(key, 3, 15 * 60 * 1000)) {
    return tooMany(retryAfterSeconds(key), "تلاش‌های زیاد برای پاک‌سازی — ۱۵ دقیقه دیگر دوباره تلاش کنید");
  }

  try {
    const body = (await req.json().catch(() => ({}))) as { password?: unknown };
    const password = typeof body.password === "string" ? body.password : "";
    if (!password) {
      return Response.json({ error: "برای تأیید پاک‌سازی، رمز عبور سازنده الزامی است" }, { status: 400 });
    }
    const me = await db.user.findUnique({ where: { id: uid } });
    if (!me || !(await verifyPassword(password, me.password))) {
      return Response.json({ error: "رمز عبور صحیح نیست" }, { status: 403 });
    }

    // حذف همه داده‌ها — ترتیب بر اساس وابستگی‌ها
    // امنیت: install_id و trial_until حذف «نمی‌شوند» تا:
    //  ۱) بعد از reset، دوره آزمایشی جدید گرفته نشود
    //  ۲) کلیدهای قفل‌شده به installId باطل نشوند
    // حساب‌های مالک (OWNER_MOBILES) مطابق سیاست برنامه حذف نمی‌شوند — فراخوانِ این
    // مسیر همیشه مالک است، پس OWNER_MOBILES ناظمِ همین درخواست غیرخالی است
    const ownerMobiles = (process.env.OWNER_MOBILES || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    await db.$transaction([
      db.orderItem.deleteMany({}),
      db.payment.deleteMany({}), // پرداخت‌ها به Order ارجاع دارند — قبل از سفارش‌ها
      db.order.deleteMany({}),
      db.product.deleteMany({}),
      db.productGroup.deleteMany({}),
      db.customer.deleteMany({}),
      db.accessGrant.deleteMany({}),
      db.messageRecipient.deleteMany({}), // ممیزی v1.1.2 — بدون این، پیام‌های ارسالی بی‌دلیل در DB می‌ماندند
      db.message.deleteMany({}),
      db.licenseCharge.deleteMany({}),
      db.licenseSale.deleteMany({}),
      db.authSession.deleteMany({}),
      db.rateLimitBucket.deleteMany({}), // ممیزی v1.1.2 — کلیدهای شامل IP در پاک‌سازی کامل باقی نمی‌مانند
      db.user.deleteMany({ where: ownerMobiles.length ? { mobile: { notIn: ownerMobiles } } : {} }),
      db.setting.deleteMany({ where: { key: { notIn: ["install_id", "trial_until"] } } }),
    ]);
    // ثبت تاریخ پاک‌سازی (حسابرسی) — پس از تراکنش تا deleteMany تنظیمات آن را پاک نکند
    const resetAt = new Date().toISOString();
    await db.setting.upsert({
      where: { key: "data_full_reset_at" },
      update: { value: resetAt },
      create: { key: "data_full_reset_at", value: resetAt },
    });
    // فایل‌های پشتیبان هم حذف می‌شوند تا هیچ داده‌ای باقی نماند —
    // خطای حذف فایل (دسترسی/قفل فایل) تأیید پاک‌سازی دیتابیس را باطل نمی‌کند؛
    // به‌عنوان هشدار (backupsDeleted=false) به سازنده برگردانده می‌شود
    let backupsDeleted = true;
    try {
      await deleteAllBackups();
    } catch (e) {
      backupsDeleted = false;
      console.error("admin reset: backup files delete failed", (e as Error)?.name || "unknown");
    }

    return Response.json({ ok: true, backupsDeleted });
  } catch (e) {
    console.error("admin reset error", e);
    return Response.json({ error: "خطا در پاک‌سازی برنامه" }, { status: 500 });
  }
}
