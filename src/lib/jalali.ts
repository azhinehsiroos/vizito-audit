import { toJalaali, toGregorian, jalaaliMonthLength as _jalaaliMonthLength } from "jalaali-js";

export const FA_MONTHS = [
  "فروردین",
  "اردیبهشت",
  "خرداد",
  "تیر",
  "مرداد",
  "شهریور",
  "مهر",
  "آبان",
  "آذر",
  "دی",
  "بهمن",
  "اسفند",
];

export const FA_WEEKDAYS = ["ش", "ی", "د", "س", "چ", "پ", "ج"];

const faDigits = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

export function toFa(input: string | number): string {
  return String(input).replace(/\d/g, (d) => faDigits[Number(d)]);
}

export function toEnDigits(input: string): string {
  return input
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}

export function formatMoney(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  const s = new Intl.NumberFormat("en-US").format(Math.round(v));
  return toFa(s);
}

export function jalaliOf(date: Date | string): { jy: number; jm: number; jd: number } {
  const d = typeof date === "string" ? new Date(date) : date;
  return toJalaali(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** ۱۴۰۳/۰۸/۱۲ */
export function formatJalali(date: Date | string | null | undefined): string {
  if (!date) return "-";
  const { jy, jm, jd } = jalaliOf(date);
  return toFa(`${jy}/${String(jm).padStart(2, "0")}/${String(jd).padStart(2, "0")}`);
}

/** ۱۲ آبان ۱۴۰۳ */
export function formatJalaliLong(date: Date | string | null | undefined): string {
  if (!date) return "-";
  const { jy, jm, jd } = jalaliOf(date);
  return `${toFa(jd)} ${FA_MONTHS[jm - 1]} ${toFa(jy)}`;
}

export function formatJalaliDateTime(date: Date | string | null | undefined): string {
  if (!date) return "-";
  const d = typeof date === "string" ? new Date(date) : date;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${formatJalali(d)} - ${toFa(`${hh}:${mm}`)}`;
}

/** میلادی ISO از تاریخ شمسی */
export function jalaliToIso(jy: number, jm: number, jd: number): string {
  const g = toGregorian(jy, jm, jd);
  return new Date(g.gy, g.gm - 1, g.gd, 12, 0, 0).toISOString();
}

export function jalaaliMonthLength(jy: number, jm: number): number {
  return _jalaaliMonthLength(jy, jm);
}

/** روز هفته شمسی: 0=شنبه ... 6=جمعه */
export function jalaliWeekday(date: Date): number {
  return (date.getDay() + 1) % 7;
}

/** ابتدای ماه شمسی به میلادی */
export function firstDayOfJalaliMonth(jy: number, jm: number): Date {
  const g = toGregorian(jy, jm, 1);
  return new Date(g.gy, g.gm - 1, g.gd);
}

/** فاصله زمانی خوانا بین دو تاریخ */
export function daysBetween(a: Date, b: Date): number {
  return Math.ceil((b.getTime() - a.getTime()) / 86400000);
}

/** برچسب باقی‌مانده اعتبار */
export function expiryLabel(expiresAt: string | Date): string {
  const exp = typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt;
  const diff = exp.getTime() - Date.now();
  if (diff <= 0) return "منقضی شده";
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return `${toFa(Math.floor(diff / 60000))} دقیقه باقی‌مانده`;
  if (hours < 24) return `${toFa(hours)} ساعت باقی‌مانده`;
  const days = Math.floor(hours / 24);
  if (days < 31) return `${toFa(days)} روز باقی‌مانده`;
  const months = Math.floor(days / 30);
  return `${toFa(months)} ماه باقی‌مانده`;
}

/** مدت‌های پیش‌فرض اعتبار دسترسی (ساعت) */
export const DURATION_PRESETS: { label: string; hours: number | null; value?: number }[] = [
  { label: "۱ ساعت", hours: 1 },
  { label: "۶ ساعت", hours: 6 },
  { label: "۲۴ ساعت (۱ روز)", hours: 24 },
  { label: "۳ روز", hours: 72 },
  { label: "۱ هفته", hours: 168 },
  { label: "۱ ماه", hours: 720 },
  { label: "۳ ماه", hours: 2160 },
  { label: "۶ ماه", hours: 4320 },
  { label: "۱ سال", hours: 8760 },
  { label: "بدون انقضا", hours: null },
];
