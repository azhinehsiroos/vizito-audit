"use client";

/**
 * لایه مدیریت حالت آفلاین — بخش ۵ سند طراحی SaaS
 * -----------------------------------------------------------------------------
 * - هویت دستگاه: UUID در localStorage + هدر X-Vizito-Device (فقط شناسه — نه اعتبارنامه)
 * - تشخیص آنلاین/آفلاین: navigator.onLine + رویدادهای online/offline
 * - آینه‌سازی اسنپ‌شات: پس از هر دریافت موفق از سرور، داده در IndexedDB ذخیره می‌شود
 * - نشست آفلاین: آخرین وضعیت /api/auth/me و /api/license/status برای ورود بدون شبکه
 *
 * قاعده امنیتی: هیچ توکنی اینجا ذخیره نمی‌شود؛ نشست فقط کوکی HttpOnly است.
 * در حالت آفلاین، تصمیم‌های مجاز/ممنوع (بخش ۵.۲) در UI اعمال می‌شود و سرور هم
 * برای همه عملیات تغییردهنده مستقل تصمیم می‌گیرد.
 */

import { snapshotGet, snapshotPut } from "@/lib/idb";

// ── هویت دستگاه ──

const DEVICE_KEY = "vizito-device-id";

/** UUID پایدار دستگاه — یک‌بار ساخته و همیشه همان می‌ماند */
export function getDeviceId(): string {
  if (typeof localStorage === "undefined") return "";
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return "";
  }
}

/**
 * clientRef سفارش آفلاین — UUID یکتای سراسری (بخش ۵.۳ سند: ضد ثبت تکراری سمت سرور).
 * fallback برای محیط‌های بدون crypto.randomUUID (مثلاً http غیرامن)
 */
export function newClientRef(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(16).padStart(12, "0")}-aaaa-bbbb-cccc-${Math.random().toString(16).slice(2, 14).padStart(12, "0")}`;
}

// ── تشخیص آنلاین/آفلاین ──

export function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}

/** اشتراک رویدادهای اتصال — خروجی: تابع لغو اشتراک */
export function onConnectionChange(cb: (online: boolean) => void): () => void {
  const up = () => cb(true);
  const down = () => cb(false);
  window.addEventListener("online", up);
  window.addEventListener("offline", down);
  return () => {
    window.removeEventListener("online", up);
    window.removeEventListener("offline", down);
  };
}

// ── اسنپ‌شات داده ──

export type SnapshotMeta = { syncedAt: string } | null;

/** آینه‌سازی پس از دریافت موفق — هر خطا بی‌صدا (آفلاین اختیاری است، مانع کار آنلاین نیست) */
export async function mirror(key: string, value: unknown): Promise<void> {
  try {
    await snapshotPut(key, value);
  } catch {}
}

/** خواندن اسنپ‌شات با متادیتای آخرین همگام‌سازی */
export async function readSnapshot<T>(key: string): Promise<{ value: T; syncedAt: string } | null> {
  try {
    return await snapshotGet<T>(key);
  } catch {
    return null;
  }
}

// ── نشست آفلاین (کاربر جاری) ──

export type OfflineMe = {
  id: string;
  mobile: string;
  name: string;
  company: string | null;
  role: string;
  sections: string[];
  grantExpiresAt: string | null;
  isAdmin: boolean;
  isOwner: boolean;
  kind: string;
  orgName: string | null;
  licenseLocked: boolean;
  trialUntil: string | null;
};

export async function mirrorMe(me: OfflineMe): Promise<void> {
  await mirror("me", me);
}

export async function readMeSnapshot(): Promise<OfflineMe | null> {
  const snap = await readSnapshot<OfflineMe>("me");
  return snap ? snap.value : null;
}

// ── سیاست ورود آفلاین در قفل لایسنس (بخش ۵.۴ سند) ──

/**
 * آیا در قطعی اینترنت با این فاز قفل می‌توان وارد اپ شد؟
 *  - انقضای لایسنس/پایان ترِیال: بله — «نمایش + سفارش‌گیری + PDF» حفظ می‌شود
 *    (معیار پذیرش: اطلاعات و سفارش‌گیری پس از انقضا در دستگاه کار می‌کند)
 *  - تعلیق (SUSPENDED): خیر — فقط صفحه وضعیت/پشتیبانی (هنگام اتصال)
 *  - بدون فاز مشخص: خیر — محتاط‌ترین حالت
 */
export function offlineBypassAllowed(phase: string | null | undefined): boolean {
  return phase === "TRIAL_OVER" || phase === "LICENSE_EXPIRED";
}

/** فاز قفل ذخیره‌شده در اسنپ‌شات لایسنس — برای تصمیم ورود آفلاین */
export async function readCachedLicensePhase(): Promise<string | null> {
  const snap = await readSnapshot<{ phase?: string | null }>("license");
  return snap?.value?.phase ?? null;
}
