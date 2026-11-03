/**
 * اعتبارسنجی و پاک‌سازی ورودی‌های سرور
 * همه داده‌های دریافتی از کلاینت باید از این توابع عبور کنند.
 */

export function strField(v: unknown, maxLen: number): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, maxLen);
}

export function strOrNull(v: unknown, maxLen: number): string | null {
  const s = strField(v, maxLen);
  return s || null;
}

/** عدد امن در بازه مشخص — NaN/منفی/غیرعدد را کنترل می‌کند */
export function clampNum(v: unknown, min: number, max: number, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** تصحیح ارقام فارسی/عربی به انگلیسی برای شماره‌ها */
export function normalizeDigits(v: unknown): string {
  if (typeof v !== "string") return "";
  const fa = "۰۱۲۳۴۵۶۷۸۹";
  const ar = "٠١٢٣٤٥٦٧٨٩";
  return v
    .split("")
    .map((ch) => {
      const fi = fa.indexOf(ch);
      if (fi >= 0) return String(fi);
      const ai = ar.indexOf(ch);
      if (ai >= 0) return String(ai);
      return ch;
    })
    .join("");
}

export const MOBILE_RE = /^09\d{9}$/;

/** موبایل معتبر ایرانی یا "" */
export function normalizeMobile(v: unknown): string {
  return normalizeDigits(v).replace(/\D/g, "").slice(0, 11);
}

export const VALID_PRICE_TYPES = ["STORE", "PHARMACY", "SALON", "PURCHASE"] as const;
export const VALID_CUSTOMER_TYPES = ["STORE", "PHARMACY", "SALON"] as const;
export const VALID_SECTION_KEYS = [
  "dashboard",
  "customers",
  "products",
  "orders",
  "reports",
  "catalogs",
  "users",
  "purchase_price",
  "all_customers",
] as const;

export function inWhitelist<T extends readonly string[]>(v: unknown, list: T, fallback: T[number]): T[number] {
  return typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T[number]) : fallback;
}

/** فیلتر کردن کلیدهای بخش به فقط کلیدهای شناخته‌شده */
export function filterSections(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((s): s is string => typeof s === "string" && (VALID_SECTION_KEYS as readonly string[]).includes(s)))];
}

/** فقط data URL تصویر با فرمت مجاز — جلوگیری از تزریق محتوای غیرتصویری */
export function isSafeImageDataUrl(v: unknown): boolean {
  if (typeof v !== "string") return false;
  return /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v);
}

export function isFiniteDate(v: unknown): boolean {
  return typeof v === "string" && !Number.isNaN(new Date(v).getTime());
}
