"use client";

/**
 * لایه ذخیره‌سازی محلی IndexedDB — حالت آفلاین (بخش ۵.۱ سند طراحی SaaS)
 * -----------------------------------------------------------------------------
 * سه فروشگاه (در یک دیتابیس «به ازای هر حساب کاربری»):
 *  ۱) support-outbox — صف پیام‌های پشتیبانی در انتظار ارسال (فاز پشتیبانی)
 *  ۲) orders-outbox — سفارش‌های آفلاین در انتظار همگام‌سازی (بخش ۵.۳)
 *  ۳) snapshot — اسنپ‌شات آخرین همگام‌سازی: مشتریان، کالاها/گروه‌ها، تنظیمات،
 *     وضعیت لایسنس، کاربر جاری، خلاصه داشبورد — هر رکورد با syncedAt
 *
 * قواعد حیاتی (اصلاح فاز A — گزارش ممیزی C1/H4/M5):
 *  - هیچ توکن/رمزی اینجا نگه‌داری نمی‌شود (نشست فقط کوکی HttpOnly است)
 *  - «تا ack سرور (ثبت clientRef) از صف حذف نمی‌شود» — بستن برنامه/خاموشی
 *    دستگاه/خروج از حساب صف را حذف نمی‌کند (قانون مرحله ۸ دستور تجاری)
 *  - جداسازی حساب‌ها: هر حساب کاربری DB اختصاصی خودش را دارد
 *    (vizito-u<userId>) — داده‌های حساب قبلی هرگز در حساب بعدی نمایش داده
 *    نمی‌شود و صف سفارش‌ها به سازمان/کاربر/دستگاه اصلی خود گره خورده می‌ماند
 *  - خروج از حساب فقط «آینه نشست» (کلید me) را پاک می‌کند؛ صف‌ها و کش داده
 *    در DB همان حساب می‌مانند و پس از ورود مجدد همان حساب دوباره در دسترس و
 *    همگام می‌شوند (حریم خصوصی بین حساب‌ها با جداسازی DB تضمین می‌شود؛
 *    رمزنگاری at-rest موضوع فاز C است)
 */

const LEGACY_DB_NAME = "vizito-db"; // نصب‌های قبل از فاز A — یک‌بار مهاجرت داده می‌شوند
const LEGACY_MIGRATED_KEY = "vizito-legacy-migrated";
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

// ── مدیریت حساب فعال (جداسازی per-حساب) ──

/** نام DB حساب جاری — تا پیش از ورود null است و همه عملیات بی‌اثر می‌شوند */
let activeDbName: string | null = null;

/** آیا DB محلی برای حساب واردشده آماده شده است؟ (گارد چرخه همگام‌سازی — M7) */
export function isLocalDbInitialized(): boolean {
  return activeDbName !== null;
}

/** آماده‌سازی DB محلی «به نام حساب کاربری» — پیش از هر خواندن/نوشتن فراخوانی می‌شود */
export async function initLocalDbForUser(userId: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  try {
    const safe = (userId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    if (!safe) return;
    const name = `vizito-u${safe}`;
    if (activeDbName === name) return;
    activeDbName = name;
    // اطمینان از وجود فروشگاه‌ها در DB این حساب
    await openNamedDb(name);
    // مهاجرت یک‌باره نصب‌های قدیمی (صف‌های قبل از فاز A) به DB همین حساب
    await migrateLegacyDbIfNeeded();
  } catch {
    // آماده‌سازی ناموفق — عملیات آفلاین در این دستگاه غیرفعال می‌ماند (مانع بوت نیست)
  }
}

/**
 * خروج از حساب — فقط اشاره‌گر حساب فعال ریست می‌شود.
 * هیچ داده‌ای حذف نمی‌شود (C1: سفارش‌های همگام‌نشده محفوظ می‌مانند)؛
 * با reset شدن نام DB، هر عملیات باقی‌مانده در جریان بی‌اثر می‌شود (M7).
 */
export function closeLocalDb(): void {
  activeDbName = null;
}

/** بازکردن DB با نام مشخص — ساخت فروشگاه‌ها در اولین بار */
function openNamedDb(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    try {
      const req = indexedDB.open(name, DB_VERSION);
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

/** بازکردن دیتابیس حساب جاری — در محیط بدون IndexedDB یا پیش از ورود، null */
function openDb(): Promise<IDBDatabase | null> {
  if (!activeDbName) return Promise.resolve(null);
  return openNamedDb(activeDbName);
}

/** مهاجرت یک‌باره از DB مشترک قدیمی (vizito-db) به DB حساب جاری.
 * صف سفارش‌ها/پشتیبانیِ نصب قدیمی به «اولین حسابی که پس از ارتقا وارد می‌شود»
 * منتسب می‌شود (صاحب واقعی همان نشست فعال قبلی است)؛ اسنپ‌شات عمداً منتقل
 * نمی‌شود تا یک sync تازه ساخته شود. idempotent — با پرچم localStorage. */
async function migrateLegacyDbIfNeeded(): Promise<void> {
  if (typeof indexedDB === "undefined" || typeof localStorage === "undefined") return;
  try {
    if (localStorage.getItem(LEGACY_MIGRATED_KEY) === "1") return;
    const legacy = await new Promise<IDBDatabase | null>((resolve) => {
      try {
        const req = indexedDB.open(LEGACY_DB_NAME);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    if (!legacy) {
      localStorage.setItem(LEGACY_MIGRATED_KEY, "1");
      return;
    }
    const readAll = (store: string): Promise<unknown[]> =>
      new Promise((resolve) => {
        try {
          const tx = legacy.transaction(store, "readonly");
          const req = tx.objectStore(store).getAll();
          req.onsuccess = () => resolve((req.result as unknown[]) || []);
          req.onerror = () => resolve([]);
        } catch {
          resolve([]); // فروشگاه در نصب خیلی قدیمی وجود ندارد
        }
      });
    const legacyOrders = await readAll(STORE_ORDERS);
    const legacySupport = await readAll(STORE_SUPPORT);
    // انتقال با همان clientRef (put upsert — idempotent؛ سرور هم ضدتکرار دارد)
    for (const o of legacyOrders) {
      if (o && typeof o === "object" && "clientRef" in (o as Record<string, unknown>)) {
        await withStore(STORE_ORDERS, "readwrite", (s) => s.put(o as OrderOutboxItem) as unknown as IDBRequest<IDBValidKey>);
      }
    }
    for (const m of legacySupport) {
      if (m && typeof m === "object" && "clientRef" in (m as Record<string, unknown>)) {
        await withStore(STORE_SUPPORT, "readwrite", (s) => s.put(m as SupportOutboxItem) as unknown as IDBRequest<IDBValidKey>);
      }
    }
    legacy.close();
    localStorage.setItem(LEGACY_MIGRATED_KEY, "1");
    // حذف DB قدیمی — اگر تب دیگری باز باشد به تعویق می‌افتد (بی‌خطر؛ دیگر خوانده نمی‌شود)
    try {
      indexedDB.deleteDatabase(LEGACY_DB_NAME);
    } catch {
      /* بی‌خطر */
    }
  } catch {
    // مهاجرت اختیاری است — هرگز مانع بوت نشود
  }
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

/** تخلیه کامل صف پشتیبانی — فقط برای «پاک‌سازی دستی با تأیید صریح» (فاز C) */
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

/** تخلیه کامل صف سفارش‌ها — فقط برای «حذف دستی با تأیید صریح» (فاز C؛ هرگز در خروج) */
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

/** حذف یک کلید اسنپ‌شات — خروج از حساب فقط «آینه نشست» (me) را پاک می‌کند (C1) */
export async function snapshotDelete(key: string): Promise<void> {
  await withStore(STORE_SNAPSHOT, "readwrite", (s) => s.delete(key) as unknown as IDBRequest<undefined>);
}

/**
 * پاک‌سازی کامل همه فروشگاه‌های حساب جاری.
 * ⚠️ دیگر در «خروج از حساب» استفاده نمی‌شود (C1 — قانون مرحله ۸: خروج نباید
 * سفارش‌های ارسال‌نشده را حذف کند). فقط برای یک اکشن دستی آیندهِ «پاک‌سازی
 * داده‌های این دستگاه» با دیالوگ تأیید صریح نگه داشته شده است (فاز C).
 */
export async function clearAllLocalData(): Promise<void> {
  await Promise.all([
    outboxClear(),
    orderOutboxClear(),
    withStore(STORE_SNAPSHOT, "readwrite", (s) => s.clear() as unknown as IDBRequest<undefined>),
  ]);
}
