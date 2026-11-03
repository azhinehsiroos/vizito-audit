"use client";

/**
 * لایه ارتباط با API — احراز هویت با کوکی HttpOnly (بدون ذخیره توکن در جاوااسکریپت)
 * امنیت: در حالت عادی توکن در localStorage نیست ⇒ XSS نمی‌تواند آن را بخواند.
 *
 * توکن پشتیبان (Fallback):
 *   در برخی بسترها (مثل نمایش برنامه داخل iframe بین‌سایتی در پنل‌های میزبان) مرورگر
 *   کوکی نشست را ذخیره نمی‌کند. در این حالت پس از ورود موفق، توکن به‌عنوان «پشتیبان»
 *   در localStorage ذخیره و با هدر Authorization: Bearer ارسال می‌شود.
 *   اگر کوکی کار کند (حالت عادی)، این توکن هرگز ذخیره نمی‌شود و با خروج پاک می‌شود.
 */
export type ApiError = { error: string; status: number };

const FALLBACK_TOKEN_KEY = "vizito_fb_token";

function getFallbackToken(): string | null {
  try {
    return localStorage.getItem(FALLBACK_TOKEN_KEY);
  } catch {
    return null; // حافظه در دسترس نیست (مثلاً sandbox سخت‌گیرانه)
  }
}

/** ذخیره/پاک‌کردن توکن پشتیبان — فقط وقتی کوکی در بستر جاری کار نمی‌کند استفاده می‌شود */
export function saveFallbackToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(FALLBACK_TOKEN_KEY, token);
    else localStorage.removeItem(FALLBACK_TOKEN_KEY);
  } catch {
    /* حافظه در دسترس نیست */
  }
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const fbToken = getFallbackToken();
  if (fbToken) headers["Authorization"] = `Bearer ${fbToken}`;

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
    // توکن پشتیبان منقضی/نامعتبر است — پاک شود (کوکی HttpOnly ممکن است همچنان معتبر باشد)
    if (res.status === 401 && fbToken) saveFallbackToken(null);
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
