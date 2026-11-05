"use client";

/**
 * لایه ارتباط با API — احراز هویت «فقط» با کوکی HttpOnly
 * -----------------------------------------------------------------------------
 * امنیت:
 *  - توکن نشست هرگز در localStorage/sessionStorage/cookie غیر HttpOnly ذخیره نمی‌شود
 *    ⇒ جاوااسکریپت (و XSS) به توکن دسترسی ندارد.
 *  - مرورگر کوکی HttpOnly را خودکار در همه درخواست‌های same-origin می‌فرستد؛
 *    اینجا هیچ هدر Authorization دستی ساخته نمی‌شود.
 *  - نسخه Android هم یک WebView تک‌دامینه با کوکی first-party است
 *    (MainActivity: CookieManager.setAcceptCookie(true)) ⇒ همان کوکی HttpOnly
 *    در WebView ذخیره و ارسال می‌شود و JS به آن دسترسی ندارد — راهکار امن و
 *    بدون نیاز به Bearer Token.
 *  - اگر مرورگر در بستر خاصی کوکی را ذخیره نکند (مثلاً iframe بسیار محدود)،
 *    کاربر دوباره صفحه ورود می‌بیند — دیگر «توکن پشتیبان در localStorage» وجود
 *    ندارد (طبق ممیزی امنیتی v1.0.9 حذف شد).
 */
export type ApiError = { error: string; status: number };

/** هویت دستگاه (بخش ۵.۱ سند) — فقط شناسه است، نه اعتبارنامه؛ نشست همچنان کوکی HttpOnly */
function deviceHeader(): Record<string, string> {
  try {
    // import دایره‌ای نداریم — خواندن مستقیم localStorage با همان کلید offline.ts
    const id = typeof localStorage !== "undefined" ? localStorage.getItem("vizito-device-id") : null;
    return id ? { "X-Vizito-Device": id.slice(0, 64) } : {};
  } catch {
    return {};
  }
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  // الزام امنیتی (ضد CSRF): هر درخواست تغییردهنده باید Content-Type: application/json داشته باشد
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...deviceHeader(),
  };

  const res = await fetch(path, {
    method: options.method || "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    // نشست منقضی/ابطال‌شده → بازگشت خودکار به صفحه ورود
    // (مسیرهای ورود/ثبت‌نام/من مستثنا هستند تا در بوت اولیه حلقه رفرش ساخته نشود)
    if (
      res.status === 401 &&
      !path.startsWith("/api/auth/login") &&
      !path.startsWith("/api/auth/register") &&
      !path.startsWith("/api/auth/me")
    ) {
      if (typeof window !== "undefined" && !window.location.hash.includes("session-expired")) {
        window.location.hash = "session-expired";
        window.location.reload();
      }
    }
    const msg = (data as ApiError)?.error || `خطا در ارتباط با سرور (${res.status})`;
    const err = new Error(msg) as Error & { status?: number; code?: string };
    err.status = res.status;
    // کد خطای امنیتی سرور (مثلاً OWNER_KEY_REQUIRED / SETUP_TOKEN_REQUIRED) برای واکنش UI
    const code = (data as { code?: string })?.code;
    if (code) err.code = code;
    throw err;
  }
  return data as T;
}
