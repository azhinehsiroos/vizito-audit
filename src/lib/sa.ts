import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden, type AuthContext } from "@/lib/auth";
import { isOwnerMobile } from "@/lib/license";
import { getClientIp } from "@/lib/rate-limit";

/**
 * ابزار مشترک مسیرهای /api/sa/* — پنل مدیریت کل (فقط سازنده برنامه)
 * -----------------------------------------------------------------------------
 * - گیت دسترسی: نقش SUPER_ADMIN یا موبایل سازنده (سازگاری LEGACY قبل از بک‌فیل)
 * - حسابرسی: هر عملیات/مشاهده سازنده باید در AdminAccessLog ثبت شود
 *   (الزام بخش پنجم سند طراحی — سازنده فقط مشاهده‌گر read-only داده مجموعه‌هاست
 *   و هر دسترسی از این نوع قابل گزارش است؛ رمز عبور هیچ‌گاه در هیچ پاسخی نیست)
 */

/** گیت سازنده — نقش SUPER_ADMIN یا موبایل سازنده (سازگاری LEGACY) */
export async function requireSuper(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth;
  const isSuper = auth.ctx.isSuperAdmin || isOwnerMobile(auth.ctx.user.mobile);
  if (!auth.ctx.isAdmin || !isSuper) {
    return { error: forbidden("این بخش فقط برای سازنده برنامه است") };
  }
  return auth;
}

/**
 * M9 (اصلاح فاز B): گارد یکپارچه مالک/سازنده — جایگزین کپی‌های محلی guardOwner
 * در admin/* و license/*. همان منطق requireSuper ولی برای مسیرهایی که requireAuth
 * را با بررسی‌های اضافه (مثل رمز ریست) صدا می‌زنند: نقش SUPER_ADMIN یا موبایل سازنده.
 */
export function requireOwnerContext(ctx: AuthContext): Response | null {
  if (!ctx.isAdmin || !(ctx.isSuperAdmin || isOwnerMobile(ctx.user.mobile))) {
    return forbidden("این بخش فقط برای سازنده برنامه فعال است");
  }
  return null;
}

/**
 * داده رکورد حسابرسی — برای درج «درون تراکنش» همراه با خود عملیات (fail-closed).
 * خروجی را به tx.adminAccessLog.create({ data: ... }) بدهید.
 */
export function adminAccessLogData(
  actorId: string,
  actorName: string,
  orgId: string | null,
  action: string,
  req: NextRequest,
  detail?: string
) {
  return {
    actorId,
    actorName: actorName.slice(0, 80),
    orgId,
    action: action.slice(0, 40),
    detail: detail ? detail.slice(0, 500) : null,
    ip: getClientIp(req).slice(0, 60),
  };
}

/**
 * ثبت حسابرسی دسترسی سازنده — **fail-closed** (الزام مرحله ۵ دستور تجاری):
 * اگر ثبت لاگ شکست بخورد، خطا پرتاب می‌شود تا عملیات حساس بدون ثبت معتبر
 * انجام/افشا نشود. همه فراخوانی‌ها باید داخل try/catch مسیر باشند (هستند) —
 * شکست ⇒ ۵۰۰ عمومی بدون هیچ افشای داده.
 */
export async function logSaAccess(
  actorId: string,
  actorName: string,
  orgId: string | null,
  action: string,
  req: NextRequest,
  detail?: string
) {
  await db.adminAccessLog.create({
    data: adminAccessLogData(actorId, actorName, orgId, action, req, detail),
  });
}
