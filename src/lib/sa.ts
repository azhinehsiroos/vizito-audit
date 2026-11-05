import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden } from "@/lib/auth";
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

/** ثبت حسابرسی دسترسی سازنده — هرگز خطا به پاسخ درز نمی‌کند (log-and-forget) */
export async function logSaAccess(
  actorId: string,
  actorName: string,
  orgId: string | null,
  action: string,
  req: NextRequest,
  detail?: string
) {
  await db.adminAccessLog
    .create({
      data: {
        actorId,
        actorName: actorName.slice(0, 80),
        orgId,
        action: action.slice(0, 40),
        detail: detail ? detail.slice(0, 500) : null,
        ip: getClientIp(req).slice(0, 60),
      },
    })
    .catch(() => {});
}
