import { NextRequest } from "next/server";
import { activateLicense, getLicenseState, parseLicenseKey, getInstallId } from "@/lib/license";
import { rateLimit, retryAfterSeconds, getClientIp } from "@/lib/rate-limit";
import { csrfGate } from "@/lib/auth";

/**
 * فعال‌سازی / شارژ مجدد لایسنس با کلید — عمومی (وقتی برنامه قفل است کاربر راهی برای ورود ندارد)
 * امنیت:
 *  - گیت Content-Type: application/json (ضد CSRF بین‌سایتی)
 *  - حداکثر ۱۰ تلاش در ساعت به ازای هر IP واقعی (آخرین hop هدر X-Forwarded-For)
 *  - کلیدِ قدیمی‌تر از لایسنس فعال فعلی پذیرفته نمی‌شود ⇒ نمی‌توان با کلید منقضی دیگری سیستم را قفل کرد
 *  - کلیدِ صادرشده برای نصب دیگر (installId) پذیرفته نمی‌شود
 */
export async function POST(req: NextRequest) {
  const csrf = csrfGate(req);
  if (csrf) return csrf;
  const ip = getClientIp(req);
  const limitKey = `lic-act:${ip}`;
  if (!rateLimit(limitKey, 10, 60 * 60 * 1000)) {
    return Response.json(
      { error: "تلاش‌های زیاد — یک ساعت دیگر دوباره تلاش کنید" },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds(limitKey)) } }
    );
  }
  try {
    const body = (await req.json().catch(() => ({}))) as { key?: unknown };
    if (typeof body.key !== "string" || !body.key.trim()) {
      return Response.json({ error: "کلید لایسنس را وارد کنید" }, { status: 400 });
    }
    const key = body.key.trim();
    const payload = parseLicenseKey(key);
    if (!payload) {
      return Response.json({ error: "کلید لایسنس نامعتبر است" }, { status: 400 });
    }
    // قفل نصب: کلید صادرشده برای نصب دیگر نیست
    if (payload.v === 2 && payload.i) {
      const here = await getInstallId();
      if (payload.i !== here) {
        return Response.json({ error: "این کلید برای این نصب صادر نشده است" }, { status: 400 });
      }
    }
    // ضد قفل‌کردن سیستم با کلید قدیمی: انقضای کلید جدید باید از انقضای مؤثر فعلی بیشتر باشد
    // لایسنس دائمی (e = 0) همیشه «جدیدتر» از هر کلید مدت‌دار است
    const cur = await getLicenseState();
    if (cur.activated && cur.permanent && payload.e !== 0) {
      return Response.json(
        { error: "لایسنس فعلی این نصب دائمی است — کلید مدت‌دار جایگزین نمی‌شود" },
        { status: 400 }
      );
    }
    if (cur.activated && !cur.permanent && cur.expiresAt) {
      const curExp = new Date(cur.expiresAt).getTime();
      if (payload.e !== 0 && payload.e <= curExp) {
        return Response.json({ error: "این کلید جدیدتر از لایسنس فعلی نیست — کلید شارژ جدید را وارد کنید" }, { status: 400 });
      }
    }
    await activateLicense(key);
    const state = await getLicenseState();
    return Response.json({
      ok: true,
      name: state.name,
      expiresAt: state.expiresAt,
      daysLeft: state.daysLeft,
      customer: payload.n,
    });
  } catch (e) {
    // امنیت (ممیزی v1.1.2) — فقط پیام‌های کنترل‌شدهٔ خود برنامه به کلاینت برمی‌گردند؛
    // خطاهای دیتابیس/داخلی (که جزئیات ساختار را افشا می‌کنند) هرگز خام پاس نمی‌شوند
    const msg = (e as Error)?.message || "";
    const controlled = ["کلید لایسنس نامعتبر است", "این کلید برای این نصب صادر نشده است"];
    return Response.json(
      {
        error: controlled.includes(msg)
          ? msg
          : "خطا در فعال‌سازی لایسنس — کلید را بررسی کنید یا با سازنده تماس بگیرید",
      },
      { status: 400 }
    );
  }
}
