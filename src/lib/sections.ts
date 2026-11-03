export const SECTIONS = [
  { key: "dashboard", label: "داشبورد", icon: "LayoutDashboard" },
  { key: "customers", label: "مشتریان", icon: "Users" },
  { key: "products", label: "کالا و گروه‌ها", icon: "Package" },
  { key: "orders", label: "سفارشات", icon: "ClipboardList" },
  { key: "reports", label: "گزارشات", icon: "BarChart3" },
  { key: "catalogs", label: "کاتالوگ", icon: "BookOpen" },
  { key: "users", label: "مدیریت کاربران", icon: "UserCog" },
] as const;

export type SectionKey = (typeof SECTIONS)[number]["key"];

/** دسترسی‌های ویژه (بخش مستقل منو نیستند و فقط با اجازه مدیر فعال می‌شوند) */
export const PERMISSION_EXTRAS = [
  {
    key: "purchase_price",
    label: "مشاهده و خروجی قیمت خرید",
    hint: "قیمت خرید در کاتالوگ هرگز نمایش داده نمی‌شود؛ این دسترسی فقط برای مشاهده و گزارش قیمت خرید است",
  },
  {
    key: "all_customers",
    label: "دسترسی به تمام مشتری‌ها",
    hint: "کاربر عادی فقط مشتری‌های خودش را می‌بیند؛ با فعال‌کردن این گزینه، همه مشتری‌ها را می‌بیند و می‌تواند برای آن‌ها سفارش ثبت کند",
  },
] as const;

export type PermissionExtraKey = (typeof PERMISSION_EXTRAS)[number]["key"];

export function sectionLabel(key: string): string {
  return (
    SECTIONS.find((s) => s.key === key)?.label ||
    PERMISSION_EXTRAS.find((s) => s.key === key)?.label ||
    key
  );
}

export const PRICE_TYPES = [
  { key: "PURCHASE", label: "قیمت خرید" },
  { key: "STORE", label: "قیمت فروشگاه" },
  { key: "PHARMACY", label: "قیمت داروخانه" },
  { key: "SALON", label: "قیمت سالن" },
] as const;

export type PriceType = (typeof PRICE_TYPES)[number]["key"];

/** انواع قیمت مجاز برای کاربر — قیمت خرید فقط با اجازه مدیر */
export function visiblePriceTypes(canPurchase: boolean) {
  return PRICE_TYPES.filter((t) => canPurchase || t.key !== "PURCHASE");
}

/** انواع قیمت چاپ‌شده در کاتالوگ — قیمت خرید طبق قانون هرگز در کاتالوگ نیست */
export const CATALOG_PRICE_TYPES = PRICE_TYPES.filter((t) => t.key !== "PURCHASE");

export const CUSTOMER_TYPES = [
  { key: "STORE", label: "فروشگاه" },
  { key: "PHARMACY", label: "داروخانه" },
  { key: "SALON", label: "سالن زیبایی" },
] as const;

export function priceOfProduct(
  p: { pricePurchase: number | null; priceStore: number; pricePharmacy: number; priceSalon: number },
  type: string
): number {
  switch (type) {
    case "PURCHASE":
      return p.pricePurchase ?? 0;
    case "PHARMACY":
      return p.pricePharmacy;
    case "SALON":
      return p.priceSalon;
    default:
      return p.priceStore;
  }
}

export function priceTypeLabel(key: string): string {
  return PRICE_TYPES.find((t) => t.key === key)?.label ?? key;
}

export function priceFieldOf(type: string): string {
  switch (type) {
    case "PURCHASE":
      return "pricePurchase";
    case "PHARMACY":
      return "pricePharmacy";
    case "SALON":
      return "priceSalon";
    default:
      return "priceStore";
  }
}
