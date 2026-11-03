/**
 * محدودکننده نرخ درون‌حافظه‌ای (بدون وابستگی خارجی)
 * برای جلوگیری از حمله brute-force روی ورود/ثبت‌نام و سوءاستفاده از API
 */
import { db } from "@/lib/db";

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/** پاک‌سازی دوره‌ای سطل‌های منقضی (جلوگیری از رشد حافظه) */
function sweep() {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}

/**
 * استخراج IP واقعی کلاینت.
 * روی پلتفرم‌ها هدر x-forwarded-for «append» می‌شود؛ مقدار اول را مهاجم می‌تواند جعل کند
 * بنابراین ملاک، مقداری است که «آخرین پروکسی معتبر» اضافه کرده.
 * اگر جلوی برنامه بیش از یک پروکسی معتبر باشد (مثلاً Cloudflare + پلتفرم)،
 * تعداد آن‌ها را با env: TRUSTED_PROXY_HOPS تنظیم کنید (پیش‌فرض ۱).
 */
export function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") || "";
  const hops = fwd
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const n = Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS || 1));
  const idx = hops.length - n;
  const picked = idx >= 0 ? hops[idx] : null;
  return picked || req.headers.get("x-real-ip") || "local";
}

/**
 * بررسی مجوز درخواست.
 * @returns true اگر مجاز است، false اگر سقف پر شده باشد
 */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  if (buckets.size > 5000) sweep();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
}

/** تعداد تلاش‌های ثبت‌شده در پنجره فعلی — بدون افزایش (برای قفل مبتنی بر «تلاش ناموفق») */
export function rateLimitCount(key: string): number {
  const b = buckets.get(key);
  if (!b || b.resetAt <= Date.now()) return 0;
  return b.count;
}

/** ثانیه‌های باقی‌مانده تا رفع محدودیت (برای هدر Retry-After) */
export function retryAfterSeconds(key: string): number {
  const b = buckets.get(key);
  if (!b) return 0;
  return Math.max(1, Math.ceil((b.resetAt - Date.now()) / 1000));
}

/* ---------------------------------------------------------------------------
 * نسخه ماندگار (دیتابیسی) — فقط برای مسیرهای حساس احراز هویت (ورود/ثبت‌نام)
 * مزیت نسبت به نسخه درون‌حافظه‌ای:
 *  ۱) با ری‌استارت سرور شمارنده‌ها پاک نمی‌شوند (ضد دورزدن محدودیت با crash/ری‌استارت)
 *  ۲) بین چند نمونه سرور که همان دیتابیس را دارند مشترک است
 * هزینه: یک نوشتن دیتابیس — برای مسیرهای کم‌ترافیک احراز هویت قابل قبول است
 * ------------------------------------------------------------------------- */

/**
 * بررسی/ثبت یک تلاش در سطل ماندگار.
 * @returns true اگر مجاز است، false اگر سقف پر شده باشد
 */
export async function dbRateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = new Date();
  try {
    // ۱) افزایش اتمیک روی پنجره زنده
    const inc = await db.rateLimitBucket.updateMany({
      where: { key, expiresAt: { gt: now } },
      data: { count: { increment: 1 } },
    });
    if (inc.count === 1) {
      const b = await db.rateLimitBucket.findUnique({
        where: { key },
        select: { count: true },
      });
      return !!b && b.count <= limit;
    }
    // ۲) پنجره مرده → بازنشانی اتمیکِ شرطی (updateMany هرگز خطای یکتایی نمی‌دهد)
    const reset = await db.rateLimitBucket.updateMany({
      where: { key, expiresAt: { lte: now } },
      data: { count: 1, expiresAt: new Date(now.getTime() + windowMs) },
    });
    if (reset.count === 1) {
      // بهداشت دیتابیس: پاک‌سازی سطل‌های خیلی قدیمی (بی‌صدا)
      db.rateLimitBucket
        .deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 24 * 3600_000) } } })
        .catch(() => {});
      return true;
    }
    // ۳) سطل اصلاً وجود ندارد → ساخت (پیش از create بررسی می‌شود تا رقابتِ رایج
    // منجر به خطای یکتایی در لاگ نشود؛ فقط رقابت هم‌زمانِ بسیار نادر به catch می‌رسد)
    const existing = await db.rateLimitBucket
      .findUnique({ where: { key }, select: { expiresAt: true } })
      .catch(() => null);
    if (!existing || existing.expiresAt.getTime() <= now.getTime()) {
      await db.rateLimitBucket
        .create({ data: { key, count: 1, expiresAt: new Date(now.getTime() + windowMs) } })
        .catch(() => {}); // رقابت نادر: سطل همین لحظه توسط دیگری ساخته شده — بی‌صدا
    }
    return true;
  } catch {
    // در خطای دیتابیس مسیر را نبندیم (fail-open برای در دسترس ماندن سرویس)
    return true;
  }
}

/** تعداد تلاش‌های ثبت‌شده در پنجره زنده فعلی — بدون افزایش */
export async function dbRateLimitCount(key: string): Promise<number> {
  const b = await db.rateLimitBucket.findUnique({ where: { key }, select: { count: true, expiresAt: true } });
  if (!b || b.expiresAt.getTime() <= Date.now()) return 0;
  return b.count;
}

/** ثانیه‌های باقی‌مانده تا رفع محدودیت ماندگار (برای هدر Retry-After) */
export async function dbRetryAfterSeconds(key: string): Promise<number> {
  const b = await db.rateLimitBucket.findUnique({ where: { key }, select: { expiresAt: true } });
  if (!b) return 0;
  return Math.max(1, Math.ceil((b.expiresAt.getTime() - Date.now()) / 1000));
}
