import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden, tooMany, verifyPassword } from "@/lib/auth";
import { rateLimit, retryAfterSeconds, getClientIp } from "@/lib/rate-limit";
import { deleteAllBackups } from "@/lib/backup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * پاک‌سازی کامل برنامه (آماده‌سازی خروجی نهایی / انتقال به مشتری) — فقط مدیر
 * - همه کاربران (شامل حساب مدیر)، مشتریان، کالاها، گروه‌ها، سفارشات، تنظیمات و
 *   همه نسخه‌های پشتیبان برای همیشه حذف می‌شوند.
 * - برنامه به حالت راه‌اندازی اولیه برمی‌گردد: اولین ثبت‌نام بعدی، مدیر کل خواهد شد.
 * - امنیت: مجدداً رمز عبور مدیر الزامی است + محدودیت نرخ + هیچ پاسخی شامل داده حذف‌شده نیست.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) return forbidden("پاک‌سازی کامل فقط توسط مدیر برنامه امکان‌پذیر است");

  const uid = auth.ctx.user.id;
  const key = `rst:${uid}:${getClientIp(req)}`;
  if (!rateLimit(key, 3, 15 * 60 * 1000)) {
    return tooMany(retryAfterSeconds(key), "تلاش‌های زیاد برای پاک‌سازی — ۱۵ دقیقه دیگر دوباره تلاش کنید");
  }

  try {
    const body = (await req.json().catch(() => ({}))) as { password?: unknown };
    const password = typeof body.password === "string" ? body.password : "";
    if (!password) {
      return Response.json({ error: "برای تأیید پاک‌سازی، رمز عبور مدیر الزامی است" }, { status: 400 });
    }
    const me = await db.user.findUnique({ where: { id: uid } });
    if (!me || !(await verifyPassword(password, me.password))) {
      return Response.json({ error: "رمز عبور مدیر صحیح نیست" }, { status: 403 });
    }

    // حذف همه داده‌ها — ترتیب بر اساس وابستگی‌ها
    // امنیت: install_id و trial_until حذف «نمی‌شوند» تا:
    //  ۱) بعد از reset، دوره آزمایشی جدید گرفته نشود
    //  ۲) کلیدهای قفل‌شده به installId باطل نشوند
    await db.$transaction([
      db.orderItem.deleteMany({}),
      db.payment.deleteMany({}), // پرداخت‌ها به Order ارجاع دارند — قبل از سفارش‌ها
      db.order.deleteMany({}),
      db.product.deleteMany({}),
      db.productGroup.deleteMany({}),
      db.customer.deleteMany({}),
      db.accessGrant.deleteMany({}),
      db.licenseCharge.deleteMany({}),
      db.licenseSale.deleteMany({}),
      db.authSession.deleteMany({}),
      db.user.deleteMany({}),
      db.setting.deleteMany({ where: { key: { notIn: ["install_id", "trial_until"] } } }),
    ]);
    // فایل‌های پشتیبان هم کامل حذف می‌شوند تا هیچ داده‌ای باقی نماند
    await deleteAllBackups();

    return Response.json({ ok: true });
  } catch (e) {
    console.error("admin reset error", e);
    return Response.json({ error: "خطا در پاک‌سازی برنامه" }, { status: 500 });
  }
}
