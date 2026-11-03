import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { newToken, verifyPasswordSafe, tooMany, sessionCookie, csrfGate } from "@/lib/auth";
import {
  dbRateLimit,
  dbRateLimitCount,
  dbRateLimitReset,
  dbRetryAfterSeconds,
  getClientIp,
} from "@/lib/rate-limit";
import { isLicenseValid, licenseLockedResponse, isOwnerMobile } from "@/lib/license";
import { normalizeMobile, MOBILE_RE } from "@/lib/validate";

const WRONG_CREDENTIALS = { error: "شماره موبایل یا رمز عبور اشتباه است" };

export async function POST(req: NextRequest) {
  // ── ضد CSRF (مسیر عمومی) — بلاک login CSRF از طریق فرم/text/plain بین‌سایتی ──
  const csrf = csrfGate(req);
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
      // فقط تلاش ناموفق شمرده می‌شود — افزایش اتمیک (updateMany شرطی):
      // در انفجار موازیِ ۱۶ تایی، شمارنده یک‌جا از ۸ می‌گذرد و پاسخ درخواست‌های
      // ۹ به بعد «۴۲۹» است (نه ۴۰۱) — یعنی سقف تلاش ناموفق حتی زیر رقابت هم
      // به‌صورت پاسخ مؤثر اعمال می‌شود، نه فقط در ثبت شمارنده (ممیزی v1.0.10).
      if (!(await dbRateLimit(failKey, 8, 10 * 60 * 1000))) {
        return tooMany(
          await dbRetryAfterSeconds(failKey),
          "تلاش‌های ناموفق زیاد — ۱۰ دقیقه دیگر دوباره تلاش کنید"
        );
      }
      return Response.json(WRONG_CREDENTIALS, { status: 401 });
    }

    // ورود موفق — سطل تلاش ناموفقِ همین (شماره+IP) پاک می‌شود (ضد قفل باقی‌مانده)
    await dbRateLimitReset(failKey);

    const token = await newToken(user.id, user.role, req.headers.get("user-agent"));
    // امنیت: توکن «فقط» در کوکی HttpOnly تحویل می‌شود — هیچ توکنی در بدنه پاسخ
    // برنمی‌گردد تا جاوااسکریپت (و XSS) به آن دسترسی نداشته باشد (ممیزی v1.0.9)
    return Response.json(
      {
        user: { id: user.id, mobile: user.mobile, name: user.name, role: user.role },
      },
      { headers: { "Set-Cookie": sessionCookie(req, token) } }
    );
  } catch (e) {
    console.error("login error", e);
    return Response.json({ error: "خطای سرور در ورود" }, { status: 500 });
  }
}
