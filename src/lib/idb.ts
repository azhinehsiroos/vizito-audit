"use client";

/**
 * لایه ذخیره‌سازی محلی IndexedDB — حالت آفلاین (بخش ۵.۱ سند طراحی SaaS)
 * -----------------------------------------------------------------------------
 * سه فروشگاه:
 *  ۱) support-outbox — صف پیام‌های پشتیبانی در انتظار ارسال (فاز پشتیبانی)
 *  ۲) orders-outbox — سفارش‌های آفلاین در انتظار همگام‌سازی (بخش ۵.۳)
 *  ۳) snapshot — اسنپ‌شات آخرین همگام‌سازی: مشتریان، کالاها/گروه‌ها، تنظیمات،
 *     وضعیت لایسنس، کاربر جاری، خلاصه داشبورد — هر رکورد با syncedAt
 *
 * قواعد حیاتی:
 *  - هیچ توکن/رمزی اینجا نگه‌داری نمی‌شود (نشست فقط کوکی HttpOnly است)
 *  - صف و اسنپ‌شات با خروج کاربر کامل پاک می‌شود (حریم خصوصی بخش ۱۰ سند)
 *  - «تا ack سرور (ثبت clientRef) از صف حذف نمی‌شود» — بستن برنامه/خاموشی
 *    دستگاه صف را حذف نمی‌کند
 */

const DB_NAME = "vizito-db";
const DB_VERSION = 2;
const STORE_SUPPORT = "support-outbox";
const STORE_ORDERS = "orders-outbox";
const STORE_SNAPSHOT = "snapshot";

export type SupportOutboxItem = {
  clientRef: string; // UUID — کلید صف و ضدتکرار سمت سرور
  threadId: string; // رشتهٔ مقصد؛ رشتهٔ خالی یعنی «ساخت رشتهٔ جدید»
  subjectType: string; // فقط برای ساخت رشتهٔ جدید
  body: string;
  createdAt: string; // ISO — زمان نگارش آفلاین (نمایش در UI)
};

/** سفارش آفلاین در صف همگام‌سازی — ساختار منطبق بر Order سمت سرور (denormalized) */
export type OrderOutboxItem = {
  clientRef: string; // UUID یکتای سراسری — ضد ثبت تکراری سمت سرور
  deviceId: string; // شناسه دستگاه ثبت‌کننده
  customerId: string;
  customerName: string; // نمایش آفلاین (سمت سرور از دیتابیس بازخوانی می‌شود)
  title: string | null;
  priceType: string;
  note: string | null;
  settlementType: string | null;
  dueDays: number | null;
  totalAmount: number;
  items: {
    productId: string | null;
    productName: string;
    quantity: number;
    volume: string | null;
    price: number;
    discount: number;
    offer: string | null;
    lineTotal: number;
    rowNumber: number;
  }[];
  createdAt: string; // ISO — لحظه ثبت آفلاین (نمایش و PDF)
  syncedAt: string | null; // پس از ack سرور آیتم از صف حذف می‌شود — این فیلد فقط نمایشی
  /** آخرین خطای همگام‌سازی (REJECTED سرور) — نمایش وضعیت به کاربر؛ آیتم در صف می‌ماند */
  lastError?: string | null;
};

/** رکورد اسنپ‌شات — key: customers | groups | settings | license | me | summary */
export type SnapshotEntry = {
  key: string;
  value: unknown;
  syncedAt: string; // ISO — «آخرین همگام‌سازی» برای نمایش در UI آفلاین
};

/** بازکردن دیتابیس — در محیط بدون IndexedDB (SSR/WebView خیلی قدیمی) null */
function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_SUPPORT)) {
          db.createObjectStore(STORE_SUPPORT, { keyPath: "clientRef" });
        }
        if (!db.objectStoreNames.contains(STORE_ORDERS)) {
          db.createObjectStore(STORE_ORDERS, { keyPath: "clientRef" });
        }
        if (!db.objectStoreNames.contains(STORE_SNAPSHOT)) {
          db.createObjectStore(STORE_SNAPSHOT, { keyPath: "key" });
        }
      };
      req.onblocked = () => resolve(null);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
    } catch {
      resolve(null);
    }
  });
}

// ── صف پیام پشتیبانی (فاز پشتیبانی — سازگاری کامل) ──

/** افزودن/به‌روزرسانی آیتم صف */
export async function outboxEnqueue(item: SupportOutboxItem): Promise<void> {
  await withStore(STORE_SUPPORT, "readwrite", (s) => s.put(item) as unknown as IDBRequest<IDBValidKey>);
}

/** همه آیتم‌های صف (قدیمی‌ترین اول) */
export async function outboxList(): Promise<SupportOutboxItem[]> {
  const items = await withStore<SupportOutboxItem[]>(STORE_SUPPORT, "readonly", (s) =>
    s.getAll() as IDBRequest<SupportOutboxItem[]>
  );
  return (items || []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** حذف پس از ack سرور */
export async function outboxRemove(clientRef: string): Promise<void> {
  await withStore(STORE_SUPPORT, "readwrite", (s) => s.delete(clientRef) as unknown as IDBRequest<undefined>);
}

/** تخلیه کامل صف (خروج از حساب — پاک‌سازی داده مجموعه از دستگاه) */
export async function outboxClear(): Promise<void> {
  await withStore(STORE_SUPPORT, "readwrite", (s) => s.clear() as unknown as IDBRequest<undefined>);
}

export type OutboxFlushResult = { sent: number; remaining: number };

/**
 * ارسال خودکار صف پس از اتصال — هر آیتم با همان clientRef (ضدتکرار سمت سرور).
 * send: تابع ارسال که در موفقیت resolve می‌کند (DUPLICATE سرور هم موفقیت است).
 * آیتم ناموفق در صف می‌ماند و در تلاش بعدی دوباره ارسال می‌شود (بک‌آف در سطح فراخوان).
 */
export async function flushSupportOutbox(
  send: (item: SupportOutboxItem) => Promise<void>,
  onUpdate?: () => void
): Promise<OutboxFlushResult> {
  const items = await outboxList();
  let sent = 0;
  for (const item of items) {
    try {
      await send(item);
      await outboxRemove(item.clientRef);
      sent += 1;
      onUpdate?.();
    } catch {
      // قطع اتصال در میانه تخلیه — بقیه صف می‌ماند (تا ack حذف نمی‌شود)
      break;
    }
  }
  const remaining = (await outboxList()).length;
  return { sent, remaining };
}

// ── صف سفارش آفلاین (بخش ۵.۳) ──

/** ثبت سفارش آفلاین در صف — clientRef یکتا ضدتکرار سمت سرور */
export async function orderOutboxAdd(item: OrderOutboxItem): Promise<void> {
  await withStore(STORE_ORDERS, "readwrite", (s) => s.put(item) as unknown as IDBRequest<IDBValidKey>);
}

/** همه سفارش‌های در انتظار همگام‌سازی (قدیمی‌ترین اول) */
export async function orderOutboxList(): Promise<OrderOutboxItem[]> {
  const items = await withStore<OrderOutboxItem[]>(STORE_ORDERS, "readonly", (s) =>
    s.getAll() as IDBRequest<OrderOutboxItem[]>
  );
  return (items || []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** یک سفارش از صف — برای صفحه جزئیات آفلاین */
export async function orderOutboxGet(clientRef: string): Promise<OrderOutboxItem | null> {
  const item = await withStore<OrderOutboxItem>(STORE_ORDERS, "readonly", (s) =>
    s.get(clientRef) as IDBRequest<OrderOutboxItem>
  );
  return item || null;
}

/** حذف پس از ack سرور (فاز همگام‌سازی) */
export async function orderOutboxRemove(clientRef: string): Promise<void> {
  await withStore(STORE_ORDERS, "readwrite", (s) => s.delete(clientRef) as unknown as IDBRequest<undefined>);
}

export async function orderOutboxClear(): Promise<void> {
  await withStore(STORE_ORDERS, "readwrite", (s) => s.clear() as unknown as IDBRequest<undefined>);
}

// ── اسنپ‌شات آخرین همگام‌سازی ──

/** ذخیره/به‌روزرسانی یک کلید اسنپ‌شات — پس از هر دریافت موفق از سرور صدا زده می‌شود */
export async function snapshotPut(key: string, value: unknown): Promise<void> {
  const entry: SnapshotEntry = { key, value, syncedAt: new Date().toISOString() };
  await withStore(STORE_SNAPSHOT, "readwrite", (s) => s.put(entry) as unknown as IDBRequest<IDBValidKey>);
}

/** خواندن یک کلید اسنپ‌شات — نبود ← null */
export async function snapshotGet<T = unknown>(key: string): Promise<{ value: T; syncedAt: string } | null> {
  const entry = await withStore<SnapshotEntry>(STORE_SNAPSHOT, "readonly", (s) =>
    s.get(key) as IDBRequest<SnapshotEntry>
  );
  if (!entry) return null;
  return { value: entry.value as T, syncedAt: entry.syncedAt };
}

/** پاک‌سازی کامل همه فروشگاه‌ها — فقط در خروج از حساب (حریم خصوصی) */
export async function clearAllLocalData(): Promise<void> {
  await Promise.all([
    outboxClear(),
    orderOutboxClear(),
    withStore(STORE_SNAPSHOT, "readwrite", (s) => s.clear() as unknown as IDBRequest<undefined>),
  ]);
}
