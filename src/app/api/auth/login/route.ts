import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { newToken, verifyPasswordSafe, tooMany, sessionCookie, jsonContentTypeGate } from "@/lib/auth";
import {
  dbRateLimit,
  dbRateLimitCount,
  dbRetryAfterSeconds,
  getClientIp,
} from "@/lib/rate-limit";
import { isLicenseValid, licenseLockedResponse, isOwnerMobile } from "@/lib/license";
import { normalizeMobile, MOBILE_RE } from "@/lib/validate";

const WRONG_CREDENTIALS = { error: "شماره موبایل یا رمز عبور اشتباه است" };

export async function POST(req: NextRequest) {
  // ── ضد CSRF (مسیر عمومی) — بلاک login CSRF از طریق فرم/text/plain بین‌سایتی ──
  const csrf = jsonContentTypeGate(req);
  if (csrf) return csrf;

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const mobile = normalizeMobile(body.mobile);
    const password = typeof body.password === "string" ? body.password : "";

    if (!MOBILE_RE.test(mobile) || !password) {
      return Response.json(WRONG_CREDENTIALS, { status: 401 });
    }

    // قفل لایسنس — سازنده برنامه همیشه می‌تواند وارد شود؛ بقیه بدون لایسنس معتبر ممنوع (داده‌ها حذف نمی‌شوند)
    if (!isOwnerMobile(mobile) && !(await isLicenseValid())) return licenseLockedResponse();

    const ip = getClientIp(req);
    const failKey = `login-f:${mobile}:${ip}`;

    // ضد brute-force با سطل «ماندار» در دیتابیس — با ری‌استارت سرور پاک نمی‌شود
    // سقف کل تلاش per-IP (ضد سیل) + سقف «تلاش ناموفق» per (شماره+IP)
    // شمارش فقط تلاش‌های ناموفق ⇒ مهاجم نمی‌تواند حساب قربانی را عمداً قفل کند
    if (!(await dbRateLimit(`login-ip:${ip}`, 30, 10 * 60 * 1000))) {
      return tooMany(await dbRetryAfterSeconds(`login-ip:${ip}`));
    }
    if ((await dbRateLimitCount(failKey)) >= 8) {
      return tooMany(
        await dbRetryAfterSeconds(failKey),
        "تلاش‌های ناموفق زیاد — ۱۰ دقیقه دیگر دوباره تلاش کنید"
      );
    }

    const user = await db.user.findUnique({ where: { mobile } });
    // تأیید با هم‌زمان‌سازی زمانی — وقتی کاربر وجود ندارد هم همان هزینه رمزنگاری پرداخت می‌شود
    const ok = await verifyPasswordSafe(password, user?.password ?? null);
    if (!user || !ok) {
      // فقط تلاش ناموفق شمرده می‌شود
      await dbRateLimit(failKey, 8, 10 * 60 * 1000);
      return Response.json(WRONG_CREDENTIALS, { status: 401 });
    }

    const token = await newToken(user.id, user.role, req.headers.get("user-agent"));
    // امنیت: توکن در کوکی HttpOnly ست می‌شود (به جاوااسکریپت/XSS دسترسی ندارد)
    // فیلد token در پاسخ فقط برای سازگاری نسخه‌های قدیمی اپ نصب‌شده است
    return Response.json(
      {
        token,
        user: { id: user.id, mobile: user.mobile, name: user.name, role: user.role },
      },
      { headers: { "Set-Cookie": sessionCookie(req, token) } }
    );
  } catch (e) {
    console.error("login error", e);
    return Response.json({ error: "خطای سرور در ورود" }, { status: 500 });
  }
}
