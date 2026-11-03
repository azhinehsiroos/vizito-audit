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
 * استخراج IP واقعی کلاینت — فقط با احتساب پروکسی‌های مورد اعتماد (ممیزی v1.0.9).
 * روی پلتفرم‌ها هدر x-forwarded-for «append» می‌شود؛ مقدار اول را مهاجم می‌تواند جعل کند
 * بنابراین ملاک، مقداری است که «آخرین پروکسی معتبر» اضافه کرده:
 * با TRUSTED_PROXY_HOPS=n (پیش‌فرض ۱) از انتهای زنجیره n مقدار سمتِ پروکسی معتبر
 * بیرون کشیده می‌شود؛ اگر زنجیره کوتاه‌تر از تعداد hopهای معتبر باشد (هدر جعلی پرشده)،
 * به x-real-ip و در نهایت مقدار سراسری «local» برمی‌گردد — هرگز مقدار قابل‌جعلِ
 * ابتدای زنجیره انتخاب نمی‌شود.
 */
export function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") || "";
  // سقف زنجیره: هدر غول‌آسا (DoS پارس) بی‌اثر می‌شود — فقط ۸ hop آخر معنا دارد
  const hops = fwd
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-8);
  const n = Math.min(8, Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS || 1)));
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
 * بررسی/ثبت یک تلاش در سطل ماندگار — ممیزی v1.0.9:
 *  ۱) «همه» تغییرات با updateMany شرطی (یک دستور UPDATE اتمیک SQLite) انجام می‌شود —
 *     هیچ مسیر findUnique→create وجود ندارد ⇒ نه خطای یکتایی در لاگ می‌آید و نه
 *     درخواستِ هم‌زمانِ رقیب بدون شمارش عبور می‌کند (رقابتِ «ایجاد اولیه سطل» حل شد:
 *     بازنشانی پنجره مرده هم updateMany شرطی است؛ بازنده رقابت دوباره تلاش می‌کند)
 *  ۲) fail-closed: در خطای دیتابیس «false» برمی‌گردد (درخواست رد می‌شود) —
 *     دیگر خطای دیتابیس به‌صورت پیش‌فرض اجازه عبور نمی‌دهد
 *
 * @returns true اگر مجاز است، false اگر سقف پر شده یا خطای دیتابیس رخ داده باشد
 */
export async function dbRateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = new Date();
  try {
    // حداکثر ۴ تلاش برای رسیدن به پنجره زنده (رقابت هم‌زمان روی پنجره مرده/سطل غایب)
    for (let attempt = 0; attempt < 4; attempt++) {
      // ۱) افزایش اتمیک روی پنجره زنده (یک UPDATE شرطی — هرگز خطای یکتایی نمی‌دهد)
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
      // ۲) پنجره مرده → بازنشانی اتمیکِ شرطی (شامل شمارش همین درخواست: count=1)
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
      // ۳) سطل اصلاً وجود ندارد → ساخت ردیف (شامل شمارش همین درخواست: count=1).
      //    رقابت هم‌زمان با P2002 «بی‌صدا» هندل می‌شود: برنده count=1 می‌سازد؛
      //    بازنده دور بعد با updateMany روی پنجره زنده شمرده می‌شود (بدون عبور رایگان)
      try {
        await db.rateLimitBucket.create({
          data: { key, count: 1, expiresAt: new Date(now.getTime() + windowMs) },
        });
        return true;
      } catch (e) {
        if ((e as { code?: string })?.code !== "P2002") throw e;
      }
    }
    // رقابت شدیدِ غیرعادی: این درخواست رد می‌شود (جهت خطا امن است)
    return false;
  } catch (e) {
    // ممیزی v1.0.9 — fail-closed: خطای دیتابیس دیگر «اجازه عبور» نیست
    // (هیچ مقدار حساسی لاگ نمی‌شود — فقط نوع خطا)
    console.warn(
      "vizito rate-limit: db error → fail-closed (request rejected):",
      (e as Error)?.name || "unknown"
    );
    return false;
  }
}

/**
 * ریست سطل «تلاش ناموفق» پس از ورود موفق (ممیزی v1.0.10):
 *  - قفل فقط تا وقتی معنا دارد که تلاش‌های ناموفق انباشته شده باشد؛
 *    ورود موفقِ همان (شماره+IP) سطل را پاک می‌کند تا کاربر واقعی بعد از
 *    چند اشتباهِ معمول، در همان پنجره زنده هم بتواند ادامه دهد.
 *  - ضدمهاجم: این ریست فقط با «رمز درست» قابل اجراست، پس مهاجم نمی‌تواند
 *    از آن برای پاک‌کردن سطل قربانی سوءاستفاده کند.
 *  - بهترین‌تلاش (best-effort): خطا خورده و بی‌صدا رد می‌شود — ورود موفق
 *    هرگز به‌خاطر خطای پاک‌سازی سطل شکست نمی‌خورد.
 */
export async function dbRateLimitReset(key: string): Promise<void> {
  try {
    await db.rateLimitBucket.deleteMany({ where: { key } });
  } catch {
    // عمداً بی‌صدا — ریست سطل پس از ورود موفق اجباری نیست
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
