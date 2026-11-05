import { NextRequest } from "next/server";
import { csrfGate, getAuth, unauthorized, forbidden } from "@/lib/auth";
import { db } from "@/lib/db";
import { dbRateLimit } from "@/lib/rate-limit";
import { strOrNull } from "@/lib/validate";

/**
 * ثبت/به‌روزرسانی هویت دستگاه — بخش ۵.۱ سند طراحی SaaS
 * -----------------------------------------------------------------------------
 * - دستگاه: UUID سمت کلاینت (localStorage) در هدر X-Vizito-Device
 *   «فقط شناسه است، نه اعتبارنامه» — هیچ تصمیم دسترسی بر اساس آن گرفته نمی‌شود؛
 *   نشست همچنان فقط کوکی HttpOnly است.
 * - orgId همیشه از نشست سمت سرور — هرگز از کلاینت.
 * - قفل لایسنس اعمال نمی‌شود (زیرساخت همگام‌سازی است؛ طبق بخش ۵.۴ سند،
 *   سفارش‌های آفلاین حتی پس از انقضا باید بتوانند همگام شوند).
 * - همان دستگاه با حساب مجموعه دیگر (پس از خروج/ورود) به مجموعه جدید منتقل می‌شود —
 *   کلید یکتاست و مالکیت دستگاه تابع حساب فعال روی آن دستگاه است.
 */

/** اعتبارسنجی شناسه دستگاه — رشته امن ۸ تا ۶۴ کاراکتر (UUID یا معادل) */
function validDeviceKey(v: string | null): string | null {
  if (!v) return null;
  const trimmed = v.trim();
  if (trimmed.length < 8 || trimmed.length > 64) return null;
  // فقط کاراکترهای امن شناسه — ضد هر payload عجیب در دیتابیس/لاگ
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

export async function POST(req: NextRequest) {
  const csrf = csrfGate(req);
  if (csrf) return csrf;
  const ctx = await getAuth(req);
  if (!ctx) return unauthorized();
  // دستگاه تجاری مجموعه‌محور است — حساب بدون مجموعه (سازنده/قدیمی) دستگاه ثبت نمی‌کند
  if (!ctx.org) return forbidden("ثبت دستگاه فقط برای کاربران مجموعه‌دار است");
  // لیمیت پایدار DB — جلوگیری از سوءاستفاده (۳۰ در دقیقه برای هر کاربر؛ فراخوانی عادی هر بوت یک‌بار)
  if (!(await dbRateLimit(`device:${ctx.user.id}`, 30, 60_000))) {
    return Response.json({ error: "تلاش‌های زیاد — کمی بعد دوباره تلاش کنید" }, { status: 429 });
  }
  const deviceKey = validDeviceKey(req.headers.get("x-vizito-device"));
  if (!deviceKey) {
    return Response.json({ error: "شناسه دستگاه نامعتبر است" }, { status: 400 });
  }
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const label = strOrNull(body.label, 60);
    const device = await db.device.upsert({
      where: { deviceKey },
      create: { deviceKey, orgId: ctx.org.id, userId: ctx.user.id, label },
      update: { orgId: ctx.org.id, userId: ctx.user.id, ...(label ? { label } : {}), lastSeenAt: new Date() },
      select: { id: true, deviceKey: true, label: true, lastSeenAt: true },
    });
    return Response.json({ ok: true, device });
  } catch (e) {
    console.error("device register error", e);
    return Response.json({ error: "خطا در ثبت دستگاه" }, { status: 500 });
  }
}
