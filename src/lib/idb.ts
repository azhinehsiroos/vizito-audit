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
 *    همگام می‌شوند (حریم خصوصی بین حساب‌ها با جداسازی DB تضمین می‌شود)
 *  - رمزنگاری at-rest (فاز C — مرحله ۱۰ دستور تجاری): همه رکوردها پیش از
 *    نوشتن با AES-256-GCM (WebCrypto) رمز می‌شوند — کلید ۳۲بایتی تصادفی
 *    «به ازای هر حساب» یک‌بار ساخته و در localStorage همان پروفایل نگه‌داری
 *    می‌شود. رکورد بسته‌شده: {s:2, iv, ct} — بدون رمزنگاری ممکن (HTTP غیرامن):
 *    {s:1, plain} به‌صورت شفاف و با نمایش وضعیت واقعی در UI.
 *    ⚠️ حد واقعی این محافظت (ادعای کاذب ممنوع): از خواندن مستقیم رکوردهای
 *    IndexedDB توسط کد/ابزار بیرونی جلوگیری می‌کند، اما در بستر وب کلید در
 *    همان پروفایل مرورگر/WebView است — در برابر مهاجمی که «کل پروفایل» را
 *    کپی کند یا بتواند JS در مبدأ اپ اجرا کند (XSS) محافظت کامل نیست؛
 *    محافظت کامل at-rest در Android فقط با Keystore + پل نیتیو ممکن است
 *    (مستند در فاز APK). رکوردهای قدیمیِ بدون رمز در init دوباره بسته می‌شوند
 *    (reseal — idempotent).
 */

const LEGACY_DB_NAME = "vizito-db"; // نصب‌های قبل از فاز A — یک‌بار مهاجرت داده می‌شوند
const LEGACY_MIGRATED_KEY = "vizito-legacy-migrated";
const DB_VERSION = 2;
const KEY_PREFIX = "vizito-k"; // کلید رمزنگاری at-rest هر حساب (فاز C)
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

/**
 * منطق رکورد اسنپ‌شات — key: customers | groups | settings | license | me | summary.
 * فاز C: در حافظه فیزیکی به شکل بسته ذخیره می‌شود — {key, syncedAt, s:2, iv, ct}
 * (value رمز شده) یا در نبود WebCrypto: {key, syncedAt, s:1, plain}.
 */
export type SnapshotEntry = {
  key: string;
  value: unknown;
  syncedAt: string; // ISO — «آخرین همگام‌سازی» برای نمایش در UI آفلاین
};

// ── مدیریت حساب فعال (جداسازی per-حساب) ──

/** نام DB حساب جاری — تا پیش از ورود null است و همه عملیات بی‌اثر می‌شوند */
let activeDbName: string | null = null;

/** کلید AES-GCM حساب جاری (فاز C) — در محیط بدون WebCrypto null می‌ماند (fallback شفاف) */
let activeCryptoKey: CryptoKey | null = null;

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
    await ensureAccountKey(safe); // فاز C — کلید رمزنگاری این حساب (پیش از هر خواندن/نوشتن)
    // اطمینان از وجود فروشگاه‌ها در DB این حساب
    await openNamedDb(name);
    // مهاجرت یک‌باره نصب‌های قدیمی (صف‌های قبل از فاز A) به DB همین حساب
    await migrateLegacyDbIfNeeded();
    // فاز C — بستن مجدد رکوردهای قدیمیِ بدون رمز (idempotent)
    await resealLegacyRecords();
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
  activeCryptoKey = null; // فاز C — کلید حساب قبلی در حافظه نمی‌ماند
}

// ── رمزنگاری at-rest (فاز C — AES-256-GCM/WebCrypto؛ حد واقعی در سربرگ) ──

function subtleOk(): boolean {
  try {
    return typeof crypto !== "undefined" && !!crypto.subtle && typeof localStorage !== "undefined";
  } catch {
    return false;
  }
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** کلید ۳۲بایتی تصادفی «به ازای هر حساب» — یک‌بار ساخته و در localStorage نگه‌داری می‌شود */
async function ensureAccountKey(safeUserId: string): Promise<void> {
  activeCryptoKey = null;
  if (!subtleOk() || !safeUserId) return; // fallback شفاف — وضعیت واقعی در UI نمایش داده می‌شود
  try {
    const storeKey = KEY_PREFIX + safeUserId;
    let raw = localStorage.getItem(storeKey);
    let valid = false;
    if (raw && /^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
      try {
        valid = b64decode(raw).length === 32;
      } catch {
        valid = false;
      }
    }
    if (!valid) {
      raw = b64encode(crypto.getRandomValues(new Uint8Array(32)));
      localStorage.setItem(storeKey, raw);
    }
    activeCryptoKey = await crypto.subtle.importKey(
      "raw",
      b64decode(raw as string) as BufferSource,
      "AES-GCM",
      false,
      ["encrypt", "decrypt"]
    );
  } catch {
    activeCryptoKey = null; // fallback شفاف — هرگز مانع بوت/آفلاین نشود
  }
}

/** آیا رمزنگاری at-rest واقعاً فعال است؟ (نمایش صادقانه در UI — بدون ادعای کاذب) */
export function isAtRestEncryptionAvailable(): boolean {
  return activeCryptoKey !== null;
}

/** بستن یک مقدار — {s:2, iv, ct} یا در نبود WebCrypto/خطا، fallback شفاف {s:1, plain} */
async function sealRecord(fieldName: string, fieldValue: string, value: unknown): Promise<Record<string, unknown>> {
  if (activeCryptoKey) {
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const plain = new TextEncoder().encode(JSON.stringify(value ?? null));
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        activeCryptoKey,
        plain as BufferSource
      );
      return { [fieldName]: fieldValue, s: 2, iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) };
    } catch {
      // خطای رمزنگاری — fallback شفاف (حفظ داده مهم‌تر است؛ وضعیت در UI صادقانه)
    }
  }
  return { [fieldName]: fieldValue, s: 1, plain: value ?? null };
}

/** گشودن یک رکورد صف (orders/support) — رکورد غیرقابل رمزگشایی ⇒ null (حذف از خروجی) */
async function openOutboxRecord<T>(rec: unknown): Promise<T | null> {
  if (!rec || typeof rec !== "object") return null;
  const r = rec as Record<string, unknown>;
  try {
    if (r.s === 2) return (await decryptJson(String(r.iv), String(r.ct))) as T;
    if (r.s === 1) return (r.plain as T) ?? null;
    return r as unknown as T; // رکورد legacy (پیش از reseal) — خودِ رکورد همان آیتم است
  } catch {
    return null; // کلید از دست رفته/رکورد خراب — از خروجی فیلتر می‌شود (حد محافظت؛ مستند در سربرگ فایل)
  }
}

/** گشودن رکورد اسنپ‌شات — syncedAt همیشه plaintext می‌ماند (فقط نمایش تاریخ) */
async function openSnapshotRecord<T>(rec: unknown): Promise<{ value: T; syncedAt: string } | null> {
  if (!rec || typeof rec !== "object") return null;
  const r = rec as Record<string, unknown>;
  try {
    let value: unknown;
    if (r.s === 2) value = await decryptJson(String(r.iv), String(r.ct));
    else if (r.s === 1) value = r.plain;
    else value = r.value; // legacy
    if (value === undefined) return null;
    return { value: value as T, syncedAt: String(r.syncedAt || "") };
  } catch {
    return null;
  }
}

async function decryptJson(ivB64: string, ctB64: string): Promise<unknown> {
  if (!activeCryptoKey) throw new Error("no-key");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(ivB64) as BufferSource },
    activeCryptoKey,
    b64decode(ctB64) as BufferSource
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

/**
 * یک‌بار در هر init: رکوردهای قدیمیِ بدون رمز (شکل legacy یا s:1) با کلید همین
 * حساب دوباره بسته می‌شوند — idempotent؛ رکوردهای s:2 دست‌نخورده می‌مانند.
 * هرگز مانع بوت نمی‌شود (اختیاری است).
 */
async function resealLegacyRecords(): Promise<void> {
  try {
    const rawOrders = await withStore<Record<string, unknown>[]>(STORE_ORDERS, "readonly", (s) =>
      s.getAll() as IDBRequest<Record<string, unknown>[]>
    );
    for (const rec of rawOrders || []) {
      if (rec && rec.s === 2) continue;
      const item = await openOutboxRecord<OrderOutboxItem>(rec);
      if (item && item.clientRef) await orderOutboxAdd(item);
    }
    const rawSupport = await withStore<Record<string, unknown>[]>(STORE_SUPPORT, "readonly", (s) =>
      s.getAll() as IDBRequest<Record<string, unknown>[]>
    );
    for (const rec of rawSupport || []) {
      if (rec && rec.s === 2) continue;
      const item = await openOutboxRecord<SupportOutboxItem>(rec);
      if (item && item.clientRef) await outboxEnqueue(item);
    }
    const rawSnaps = await withStore<Record<string, unknown>[]>(STORE_SNAPSHOT, "readonly", (s) =>
      s.getAll() as IDBRequest<Record<string, unknown>[]>
    );
    for (const rec of rawSnaps || []) {
      if (rec && rec.s === 2) continue;
      const opened = await openSnapshotRecord<unknown>(rec);
      if (opened && typeof rec.key === "string") await snapshotPut(rec.key, opened.value, opened.syncedAt);
    }
  } catch {
    // اختیاری — هرگز مانع بوت نشود
  }
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
    // فاز C: مسیر نوشتن از توابع عمومی می‌گذرد تا رکوردها «بسته» (رمز) ذخیره شوند
    for (const o of legacyOrders) {
      if (o && typeof o === "object" && "clientRef" in (o as Record<string, unknown>)) {
        await orderOutboxAdd(o as OrderOutboxItem);
      }
    }
    for (const m of legacySupport) {
      if (m && typeof m === "object" && "clientRef" in (m as Record<string, unknown>)) {
        await outboxEnqueue(m as SupportOutboxItem);
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

/** افزودن/به‌روزرسانی آیتم صف — فاز C: پیش از نوشتن بسته (رمز) می‌شود */
export async function outboxEnqueue(item: SupportOutboxItem): Promise<void> {
  const rec = await sealRecord("clientRef", item.clientRef, item);
  await withStore(STORE_SUPPORT, "readwrite", (s) => s.put(rec) as unknown as IDBRequest<IDBValidKey>);
}

/** همه آیتم‌های صف (قدیمی‌ترین اول) */
export async function outboxList(): Promise<SupportOutboxItem[]> {
  const recs = await withStore<Record<string, unknown>[]>(STORE_SUPPORT, "readonly", (s) =>
    s.getAll() as IDBRequest<Record<string, unknown>[]>
  );
  const items: SupportOutboxItem[] = [];
  for (const rec of recs || []) {
    const item = await openOutboxRecord<SupportOutboxItem>(rec);
    if (item && item.clientRef) items.push(item);
  }
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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

/** ثبت سفارش آفلاین در صف — clientRef یکتا ضدتکرار سمت سرور؛ فاز C: بسته (رمز) ذخیره می‌شود */
export async function orderOutboxAdd(item: OrderOutboxItem): Promise<void> {
  const rec = await sealRecord("clientRef", item.clientRef, item);
  await withStore(STORE_ORDERS, "readwrite", (s) => s.put(rec) as unknown as IDBRequest<IDBValidKey>);
}

/** همه سفارش‌های در انتظار همگام‌سازی (قدیمی‌ترین اول) */
export async function orderOutboxList(): Promise<OrderOutboxItem[]> {
  const recs = await withStore<Record<string, unknown>[]>(STORE_ORDERS, "readonly", (s) =>
    s.getAll() as IDBRequest<Record<string, unknown>[]>
  );
  const items: OrderOutboxItem[] = [];
  for (const rec of recs || []) {
    const item = await openOutboxRecord<OrderOutboxItem>(rec);
    if (item && item.clientRef) items.push(item);
  }
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** یک سفارش از صف — برای صفحه جزئیات آفلاین */
export async function orderOutboxGet(clientRef: string): Promise<OrderOutboxItem | null> {
  const rec = await withStore<Record<string, unknown>>(STORE_ORDERS, "readonly", (s) =>
    s.get(clientRef) as IDBRequest<Record<string, unknown>>
  );
  const item = await openOutboxRecord<OrderOutboxItem>(rec);
  return item && item.clientRef ? item : null;
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

/**
 * ذخیره/به‌روزرسانی یک کلید اسنپ‌شات — پس از هر دریافت موفق از سرور صدا زده می‌شود.
 * فاز C: value بسته (رمز) ذخیره می‌شود؛ syncedAt (فقط نمایش تاریخ) plaintext می‌ماند.
 * syncedAtOverride: برای reseal رکوردهای قدیمی بدون از بین بردن «آخرین همگام‌سازی» نمایشی.
 */
export async function snapshotPut(key: string, value: unknown, syncedAtOverride?: string): Promise<void> {
  const sealed = await sealRecord("key", key, value);
  const entry = { key, syncedAt: syncedAtOverride || new Date().toISOString(), ...sealed };
  await withStore(STORE_SNAPSHOT, "readwrite", (s) => s.put(entry) as unknown as IDBRequest<IDBValidKey>);
}

/** خواندن یک کلید اسنپ‌شات — نبود/غیرقابل رمزگشایی ← null */
export async function snapshotGet<T = unknown>(key: string): Promise<{ value: T; syncedAt: string } | null> {
  const rec = await withStore<Record<string, unknown>>(STORE_SNAPSHOT, "readonly", (s) =>
    s.get(key) as IDBRequest<Record<string, unknown>>
  );
  return openSnapshotRecord<T>(rec);
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
