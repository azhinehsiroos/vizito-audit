import { NextRequest } from "next/server";
import { activateLicense, getLicenseState, parseLicenseKey, getInstallId } from "@/lib/license";
import { rateLimit, retryAfterSeconds, getClientIp } from "@/lib/rate-limit";
import { jsonContentTypeGate } from "@/lib/auth";

/**
 * فعال‌سازی / شارژ مجدد لایسنس با کلید — عمومی (وقتی برنامه قفل است کاربر راهی برای ورود ندارد)
 * امنیت:
 *  - گیت Content-Type: application/json (ضد CSRF بین‌سایتی)
 *  - حداکثر ۱۰ تلاش در ساعت به ازای هر IP واقعی (آخرین hop هدر X-Forwarded-For)
 *  - کلیدِ قدیمی‌تر از لایسنس فعال فعلی پذیرفته نمی‌شود ⇒ نمی‌توان با کلید منقضی دیگری سیستم را قفل کرد
 *  - کلیدِ صادرشده برای نصب دیگر (installId) پذیرفته نمی‌شود
 */
export async function POST(req: NextRequest) {
  const csrf = jsonContentTypeGate(req);
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
    const cur = await getLicenseState();
    if (cur.activated && cur.expiresAt) {
      const curExp = new Date(cur.expiresAt).getTime();
      if (payload.e <= curExp) {
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
    return Response.json({ error: (e as Error).message || "خطا در فعال‌سازی لایسنس" }, { status: 400 });
  }
}
