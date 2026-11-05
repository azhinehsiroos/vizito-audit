import { NextRequest } from "next/server";
import { csrfGate, getAuth, unauthorized, forbidden, type AuthContext } from "@/lib/auth";
import { dbRateLimit } from "@/lib/rate-limit";

/**
 * ابزار مشترک مسیرهای پشتیبانی داخلی (بخش چهارم سند طراحی SaaS)
 * -----------------------------------------------------------------------------
 * قاعده کلیدی سند: پشتیبانی حتی در «قفل لایسنس/تعلیق مجموعه/پایان ترِیال» باز است —
 * «کل APIهای تجاری ۴۰۳؛ فقط پشتیبانی و مشاهده وضعیت». بنابراین این گیت برخلاف
 * requireAuth، قفل لایسنس را بررسی نمی‌کند؛ فقط احراز هویت + ضد CSRF اعمال می‌شود.
 *
 * محدوده: کاربر واردشدهٔ دارای مجموعه (ctx.org) — سازنده (SUPER_ADMIN بدون مجموعه)
 * از صندوق /api/sa/support استفاده می‌کند، نه این مسیرها.
 */

export type SupportAuth = { ctx: AuthContext & { org: NonNullable<AuthContext["org"]> } } | { error: Response };

/** احراز هویت پشتیبانی — بدون قفل لایسنس + گیت CSRF (لایه‌های ۱ و ۲ مثل requireAuth) */
export async function requireAuthSupport(req: NextRequest): Promise<SupportAuth> {
  const csrf = csrfGate(req);
  if (csrf) return { error: csrf };
  const ctx = await getAuth(req);
  if (!ctx) return { error: unauthorized() };
  // سازنده یا حساب قدیمی بدون مجموعه: پشتیبانی مجموعه‌محور است — مسیر خودش را ندارد
  if (!ctx.org) return { error: forbidden("پشتیبانی برای حساب‌های بدون مجموعه در دسترس نیست") };
  return { ctx: ctx as AuthContext & { org: NonNullable<AuthContext["org"]> } };
}

/** سقف طول متن پیام پشتیبانی — طبق سند (بخش دهم): ۴۰۰۰ کاراکتر */
export const SUPPORT_BODY_MAX = 4000;

/** انواع موضوع مجاز رشته پشتیبانی */
export const SUPPORT_SUBJECTS = ["GENERAL", "BUY_LICENSE", "RENEW"] as const;
export type SupportSubject = (typeof SUPPORT_SUBJECTS)[number];

export function isSupportSubject(v: unknown): v is SupportSubject {
  return typeof v === "string" && (SUPPORT_SUBJECTS as readonly string[]).includes(v);
}

export const SUBJECT_LABELS: Record<string, string> = {
  GENERAL: "پشتیبانی عمومی",
  BUY_LICENSE: "خرید لایسنس",
  RENEW: "تمدید لایسنس",
};

export const THREAD_STATUS_LABELS: Record<string, string> = {
  OPEN: "در انتظار پاسخ",
  ANSWERED: "پاسخ داده شد",
  CLOSED: "بسته شده",
};

/** اعتبارسنجی متن پیام — غیرخالی، سقف ۴۰۰۰ کاراکتر (بدون تغییری که کاربر ننوشته) */
export function supportBodyError(body: unknown): string | null {
  if (typeof body !== "string" || !body.trim()) return "متن پیام خالی است";
  if (body.length > SUPPORT_BODY_MAX) return `متن پیام حداکثر ${SUPPORT_BODY_MAX.toLocaleString("fa-IR")} کاراکتر است`;
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** اعتبارسنجی clientRef — باید UUID باشد (سند بخش دهم: اعتبارسنجی clientRef) */
export function isValidClientRef(v: unknown): v is string {
  return typeof v === "string" && v.length <= 64 && UUID_RE.test(v);
}

/** لیمیت پایدار DB برای عملیات نوشتن پشتیبانی — ۱۰ در دقیقه برای هر کاربر (سند بخش دهم) */
export async function supportWriteAllowed(userId: string): Promise<boolean> {
  return dbRateLimit(`support:${userId}`, 10, 60_000);
}
