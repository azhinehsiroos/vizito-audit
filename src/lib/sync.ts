"use client";

/**
 * موتور همگام‌سازی چنددستگاهی — بخش ۶ سند طراحی SaaS
 * -----------------------------------------------------------------------------
 * - باندل: GET /api/sync/bundle ⇒ اسنپ‌شات مجموعه در IndexedDB (مشتریان/گروه‌ها/لوگو)
 * - سفارش‌ها: POST /api/sync/orders در دسته‌های ≤۵۰ با clientRef — ACCEPTED/DUPLICATE
 *   ⇒ حذف از صف؛ REJECTED ⇒ در صف می‌ماند با ذخیره دلیل (نمایش به کاربر)
 * - پشتیبانی: POST /api/sync/support در دسته‌های ≤۲۰ — همان الگوی clientRef
 * - زمان‌بندی: در بازشدن برنامه + رویداد بازگشت اتصال + بک‌آف نمایی تا سقف ۵ دقیقه
 *   تا وقتی صفی باقی است؛ نسخه محلی تا ack سرور حذف نمی‌شود
 *
 * امنیت: همه درخواست‌ها با کوکی HttpOnly + هدر X-Vizito-Device (فقط شناسه)؛
 * هیچ orgId/توکنی از سمت کلاینت تصمیم‌ساز نیست.
 */

import { api } from "@/lib/api";
import { orderOutboxList, orderOutboxRemove, orderOutboxAdd, outboxList, outboxRemove, snapshotPut, type OrderOutboxItem } from "@/lib/idb";
import type { Customer, ProductGroup } from "@/lib/types";

export type SyncBundle = {
  syncedAt: string;
  org: { id: string; name: string; logo: string | null; status: string };
  license: {
    phase: string;
    locked: boolean;
    trial: boolean;
    permanent: boolean;
    suspended: boolean;
    expiresAt: string | null;
    daysLeft: number | null;
    trialEndsAt: string | null;
    graceUntil: string | null;
    graceDaysLeft: number | null;
  };
  customers: Customer[];
  groups: ProductGroup[];
};

/** دریافت باندل و به‌روزرسانی اسنپ‌شات محلی — خروجی: موفق/ناموفق */
export async function syncBundle(): Promise<boolean> {
  try {
    const b = await api<SyncBundle>("/api/sync/bundle");
    await snapshotPut("customers", b.customers);
    await snapshotPut("groups", b.groups);
    await snapshotPut("settings", { logo: b.org.logo });
    return true;
  } catch {
    return false;
  }
}

type OrderSyncResult = { clientRef: string; orderId?: string; result: "ACCEPTED" | "DUPLICATE" | "REJECTED"; reason?: string };

/** تخلیه صف سفارش‌های آفلاین — فقط ACCEPTED/DUPLICATE از صف حذف می‌شوند (تا ack) */
export async function flushOrderOutbox(): Promise<{ sent: number; remaining: number }> {
  const items = await orderOutboxList();
  if (items.length === 0) return { sent: 0, remaining: 0 };
  const batch = items.slice(0, 50).map((p: OrderOutboxItem) => ({
    clientRef: p.clientRef,
    customerId: p.customerId,
    title: p.title,
    priceType: p.priceType,
    note: p.note,
    settlementType: p.settlementType,
    dueDays: p.dueDays,
    items: p.items,
  }));
  try {
    const res = await api<{ results: OrderSyncResult[] }>("/api/sync/orders", {
      method: "POST",
      body: { orders: batch },
    });
    let sent = 0;
    for (const r of res.results || []) {
      if (r.result === "ACCEPTED" || r.result === "DUPLICATE") {
        await orderOutboxRemove(r.clientRef);
        sent += 1;
      } else {
        // REJECTED — دلیل در آیتم صف ثبت می‌شود (نمایش به کاربر)؛ آیتم حذف نمی‌شود
        const item = items.find((i) => i.clientRef === r.clientRef);
        if (item) {
          const reasonFa =
            r.reason === "customer"
              ? "مشتری یافت نشد یا حذف/آرشیو شده است"
              : r.reason === "customer_archived"
                ? "مشتری آرشیو شده است"
                : r.reason === "items"
                  ? "ردیف‌های سفارش نامعتبر است"
                  : r.reason === "clientRef"
                    ? "شناسه سفارش نامعتبر است"
                    : "خطای سرور — دوباره تلاش می‌شود";
          await orderOutboxAdd({ ...item, syncedAt: null, lastError: reasonFa });
        }
      }
    }
    const remaining = (await orderOutboxList()).length;
    return { sent, remaining };
  } catch {
    // قطع اتصال/خطا — کل صف می‌ماند (بک‌آف دوباره تلاش می‌کند)
    return { sent: 0, remaining: items.length };
  }
}

type SupportSyncResult = { clientRef: string; threadId?: string; messageId?: string; result: "ACCEPTED" | "DUPLICATE" | "REJECTED"; reason?: string };

/** تخلیه صف پیام‌های پشتیبانی با اندپوینت دسته‌ای — همان تضمین ack قبلی */
export async function flushSupportViaSync(): Promise<{ sent: number; remaining: number }> {
  const items = await outboxList();
  if (items.length === 0) return { sent: 0, remaining: 0 };
  const batch = items.slice(0, 20).map((i) => ({
    clientRef: i.clientRef,
    threadId: i.threadId,
    subjectType: i.subjectType,
    body: i.body,
  }));
  try {
    const res = await api<{ results: SupportSyncResult[] }>("/api/sync/support", {
      method: "POST",
      body: { messages: batch },
    });
    let sent = 0;
    for (const r of res.results || []) {
      if (r.result === "ACCEPTED" || r.result === "DUPLICATE") {
        await outboxRemove(r.clientRef);
        sent += 1;
      }
    }
    const remaining = (await outboxList()).length;
    return { sent, remaining };
  } catch {
    return { sent: 0, remaining: items.length };
  }
}

// ── زمان‌بند با بک‌آف نمایی ──

let syncing = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 5_000;
const BACKOFF_MAX = 5 * 60_000;

function clearRetry() {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function resetBackoff() {
  backoffMs = 5_000;
}

/** یک دور کامل همگام‌سازی: باندل + سفارش‌ها + پشتیبانی — هم‌پوشان اجرا نمی‌شود */
export async function runSync(onDone?: (info: { ordersRemaining: number }) => void): Promise<void> {
  if (syncing) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  syncing = true;
  try {
    await syncBundle();
    await flushOrderOutbox();
    await flushSupportViaSync();
    const [ordersPending, supportPending] = await Promise.all([orderOutboxList(), outboxList()]);
    const remaining = ordersPending.length + supportPending.length;
    clearRetry();
    if (remaining > 0) {
      // صف باقی مانده (خطا/REJECT/دسته بعدی) — بک‌آف نمایی
      retryTimer = setTimeout(() => {
        void runSync(onDone);
      }, backoffMs);
      backoffMs = Math.min(BACKOFF_MAX, backoffMs * 2);
    } else {
      resetBackoff();
    }
    onDone?.({ ordersRemaining: ordersPending.length });
  } catch {
    // خطای غیرمنتظره — بی‌صدا؛ تلاش بعدی در رویداد اتصال/بوت
  } finally {
    syncing = false;
  }
}

/** لغو زمان‌بند (خروج از حساب) */
export function cancelSyncSchedule() {
  clearRetry();
  resetBackoff();
}
