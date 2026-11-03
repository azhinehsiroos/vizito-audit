export type Customer = {
  id: string;
  name: string;
  company: string | null;
  phone: string;
  address: string | null;
  nationalId: string | null;
  type: string;
  archived?: boolean;
  archivedAt?: string | null;
  createdAt: string;
  _count?: { orders: number };
  orders?: Order[];
};

export type ProductGroup = {
  id: string;
  name: string;
  createdAt: string;
  products: Product[];
};

export type Product = {
  id: string;
  groupId: string;
  group: ProductGroup;
  name: string;
  image: string | null;
  description: string | null;
  volume: string | null;
  offer: string | null;
  pricePurchase: number | null; // فقط با اجازه مدیر مقدار دارد؛ در غیر این صورت null
  priceStore: number;
  pricePharmacy: number;
  priceSalon: number;
  discount: number;
  minOrder: number;
  createdAt: string;
};

export type OrderItem = {
  id: string;
  productId: string | null;
  productName: string;
  quantity: number;
  volume: string | null;
  price: number;
  discount: number;
  offer: string | null;
  lineTotal: number;
  rowNumber: number;
};

export type Order = {
  id: string;
  customerId: string;
  customer?: Customer;
  createdByUser?: { name: string; company: string | null };
  title: string | null;
  priceType: string;
  status: string;
  totalAmount: number;
  settlementType?: string | null; // CASH | CHECK | RECEIPT
  dueDays?: number | null; // سررسید تسویه به روز
  note: string | null;
  createdAt: string;
  items: OrderItem[];
  _count?: { items: number };
};

export type Payment = {
  id: string;
  customerId: string;
  orderId?: string | null;
  type: string; // CASH | CHECK | RECEIPT
  amount: number;
  /** تخفیف نقدی — فقط برای پرداخت نقدی (CASH) مقدار دارد */
  discountPercent?: number;
  discountAmount?: number;
  paidAt?: string | null;
  trackingNumber?: string | null;
  bankName?: string | null;
  checkNumber?: string | null;
  sayadiNumber?: string | null;
  settleAt?: string | null;
  note?: string | null;
  createdByUserId?: string | null;
  createdByUser?: { name: string } | null;
  createdAt: string;
};

export type AppUser = {
  id: string;
  mobile: string;
  name: string;
  company: string | null;
  role: string;
  kind?: string; // STAFF | PUBLIC
  disabled?: boolean; // غیرفعال‌سازی مستقل حساب
  trialUntil?: string | null; // ترِیال شخصی کاربر عمومی
  createdAt: string;
  grants: {
    id: string;
    sections: string;
    expiresAt: string | null; // null = اعتبار دائمی واقعی
    note: string | null;
    createdAt: string;
  }[];
};

/** فروش لایسنس — دفتر خریداران (فقط سازنده برنامه) */
export type LicenseSale = {
  id: string;
  buyerName: string;
  buyerMobile: string;
  durationDays: number;
  durationLabel: string;
  key: string;
  price: string | null;
  note: string | null;
  createdAt: string;
  expiresAt: string | null; // null = لایسنس دائمی
  daysLeft: number | null; // null = دائمی
  permanent?: boolean;
  pauseDeletion?: boolean; // توقف حذف خودکار توسط مالک
  charges?: LicenseCharge[];
};

/** سابقه شارژ/تمدید لایسنس خریدار */
export type LicenseCharge = {
  id: string;
  saleId: string;
  addDays: number;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
};
