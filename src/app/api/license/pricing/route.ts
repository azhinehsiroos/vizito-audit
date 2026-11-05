import { db } from "@/lib/db";

/**
 * تنظیمات عمومی فروش لایسنس — بدون نیاز به ورود (نمایش در صفحه قفل)
 * قیمت هر بازه + آیدی تلگرام پشتیبانی
 */
export async function GET() {
  const rows = await db.setting.findMany({
    where: { key: { in: ["license_prices", "support_telegram", "support_phone"] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  let prices = { m1: "", m3: "", m6: "", y1: "", perm: "" };
  try {
    prices = { ...prices, ...(JSON.parse(map.license_prices || "{}") as typeof prices) };
  } catch {
    // پیش‌فرض خالی
  }
  return Response.json({
    prices,
    telegram: map.support_telegram || "",
    // شماره تماس/پیامک پشتیبانی — مسیر جایگزین (بخش چهارم سند) — نمایش در صفحه قفل و پشتیبانی
    phone: map.support_phone || "",
    durations: [
      { key: "m1", label: "۱ ماهه", days: 30 },
      { key: "m3", label: "۳ ماهه", days: 90 },
      { key: "m6", label: "۶ ماهه", days: 180 },
      { key: "y1", label: "۱ ساله", days: 365 },
      { key: "perm", label: "دائمی", days: 0 },
    ],
  });
}
