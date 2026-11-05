import { db } from "@/lib/db";
import { createBackup } from "@/lib/backup";
import { getLicenseState, getStoredLicense, isOwnerMobile, LICENSE_GRACE_MS } from "@/lib/license";

/**
 * چرخه حیات داده پس از انقضای لایسنس (مهلت تمدید ۳۰ روزه)
 * ----------------------------------------------------------------------------
 * - پس از انقضای لایسنس مدت‌دار، همه امکانات قفل است ولی داده‌ها ۳۰ روز حفظ می‌شوند (فاز GRACE)
 * - اگر تا پایان مهلت تمدید نشود (فاز SWEEP_DUE): ابتدا «نسخه پشتیبان» تهیه و سپس
 *   داده‌های تجاری همان نصب به‌صورت کنترل‌شده حذف می‌شوند و عملیات لاگ می‌شود
 * - حساب «مالک برنامه» (OWNER_MOBILES) و حساب‌های «پرسنل» هرگز حذف نمی‌شوند
 * - لایسنس دائمی هرگز وارد چرخه انقضا/حذف نمی‌شود
 * - زمان‌ها فقط با ساعت سرور محاسبه می‌شوند (هیچ اتکایی به ساعت دستگاه نیست)
 * - توقف حذف: فقط مالک — از دفتر فروش (pauseDeletion) یا کلید retention_paused
 * - حذف با روابط دیتابیس سازگار است: سفارش/پرداخت/کالا/گروه/مشتری + نشست‌ها؛
 *   گرنت‌ها، اعلان‌ها و پیام‌های پرسنلِ حفظ‌شده دست نمی‌خورند (فقط cascade کاربران حذفی)
 */

export const DELETED_AT_KEY = "data_deleted_at"; // لاگ حذف کنترل‌شده (JSON)
export const RETENTION_PAUSED_KEY = "retention_paused"; // "1" = توقف حذف توسط مالک

export type LifecyclePhase =
  | "FRESH" // نصب تازه — هیچ حسابی نیست
  | "OWNER_UNLOCKED" // حساب مالک فعال است — قفل و حذف هرگز اجرا نمی‌شود
  | "OK" // لایسنس معتبر یا ترِیال فعال
  | "NOT_ACTIVATED" // نه لایسنس نه ترِیال (بدون چرخه حذف)
  | "GRACE" // لایسنس منقضی — داخل مهلت ۳۰ روزه
  | "SWEEP_DUE" // مهلت تمام شده — حذف کنترل‌شده در انتظار اجراست
  | "DELETED"; // حذف انجام شده (لاگ موجود است)

export type LifecycleState = {
  phase: LifecyclePhase;
  paused: boolean; // توقف حذف توسط مالک (کلید سرور یا رکورد دفتر فروش)
  expiredAt: string | null;
  graceUntil: string | null;
  graceDaysLeft: number | null;
  permanent: boolean;
  deletedAt: string | null; // اگر DELETED
  deletedLog: DeletedLog | null;
};

export type DeletedLog = {
  at: string;
  trigger: string;
  counts: Record<string, number>;
  backup?: { id: string; fileName: string; sizeBytes: number } | null;
};

/** قفل درون‌پردازشی sweep — اجرای هم‌زمان دوباره ممکن نیست */
let sweepInFlight = false;

async function isPausedBySetting(): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { key: RETENTION_PAUSED_KEY } });
  return row?.value === "1";
}

/** اگر کلیدِ فعال در دفتر فروش همین سرور ثبت شده باشد، پرچم توقف مالک همان رکورد ملاک است */
async function isPausedBySale(): Promise<boolean> {
  const lic = await getStoredLicense();
  if (!lic) return false;
  const sale = await db.licenseSale.findFirst({ where: { key: lic.key }, select: { pauseDeletion: true } });
  return !!sale?.pauseDeletion;
}

export async function lifecycleState(): Promise<LifecycleState> {
  const deletedRow = await db.setting.findUnique({ where: { key: DELETED_AT_KEY } });
  let deletedLog: DeletedLog | null = null;
  if (deletedRow) {
    try {
      deletedLog = JSON.parse(deletedRow.value) as DeletedLog;
    } catch {
      deletedLog = null;
    }
  }
  const state = await getLicenseState();
  const paused = (await isPausedBySetting()) || (await isPausedBySale());

  const base: LifecycleState = {
    phase: "OK",
    paused,
    expiredAt: state.expiredAt ?? null,
    graceUntil: state.graceUntil ?? null,
    graceDaysLeft: state.graceDaysLeft ?? null,
    permanent: !!state.permanent,
    deletedAt: deletedLog?.at ?? null,
    deletedLog,
  };

  if (deletedLog) return { ...base, phase: "DELETED" };
  if ((await db.user.count()) === 0) return { ...base, phase: "FRESH" };
  if (state.ownerUnlocked) return { ...base, phase: "OWNER_UNLOCKED" };
  if (state.valid) return { ...base, phase: "OK" };
  if (!state.activated) return { ...base, phase: "NOT_ACTIVATED" };

  // لایسنس منقضی — فاز GRACE یا SWEEP_DUE (فقط ساعت سرور)
  const graceUntilMs = state.graceUntil ? new Date(state.graceUntil).getTime() : 0;
  if (graceUntilMs > Date.now()) return { ...base, phase: "GRACE" };
  return { ...base, phase: "SWEEP_DUE" };
}

/** شمارش رکوردهای تجاری قبل از حذف — برای لاگ گزارش‌پذیر */
async function countBusinessData(): Promise<Record<string, number>> {
  const [customers, products, groups, orders, orderItems, payments, admins] = await Promise.all([
    db.customer.count(),
    db.product.count(),
    db.productGroup.count(),
    db.order.count(),
    db.orderItem.count(),
    db.payment.count(),
    db.user.count({ where: { role: "ADMIN" } }),
  ]);
  return { customers, products, groups, orders, orderItems, payments, adminAccounts: admins };
}

/**
 * حذف کنترل‌شده پس از پایان مهلت ۳۰ روزه:
 *  ۱) فقط در فاز SWEEP_DUE و فقط اگر مالک آن را متوقف نکرده باشد
 *  ۲) ابتدا نسخه پشتیبان رمزنگاری‌شده تهیه می‌شود — شکست پشتیبان ⇒ لغو حذف (fail-safe)
 *  ۳) حذف: پرداخت‌ها، اقلام، سفارش‌ها، مشتریان، کالاها، گروه‌ها + حساب‌های ADMIN غیرِ مالک
 *  ۴) حفظ: حساب مالک، حساب‌های پرسنل (USER)، گرنت‌ها، اعلان‌ها و پیام‌های آن‌ها
 *  ۵) همه نشست‌ها ابطال می‌شوند و عملیات با تاریخ/تعداد/نام پشتیبان لاگ می‌شود
 */
export async function runDataRetentionSweep(
  trigger: string
): Promise<{ ran: boolean; phase: LifecyclePhase; reason?: string; deletedLog?: DeletedLog }> {
  if (sweepInFlight) return { ran: false, phase: "SWEEP_DUE", reason: "in-flight" };
  sweepInFlight = true;
  try {
    // تصمیم D2 (SaaS v2.0): حذف خودکار داده به‌دلیل انقضای لایسنس به‌طور پیش‌فرض «غیرفعال» است —
    // سند تجاری جدید: اطلاعات مجموعه هرگز با انقضای لایسنس حذف نمی‌شود و سفارش‌گیری آفلاین
    // ادامه دارد. این چرخه قدیمی فقط با env: VIZITO_RETENTION_SWEEP=on (روی سرور سازنده)
    // دوباره فعال می‌شود؛ کد دست‌نخورده حفظ شده است.
    if ((process.env.VIZITO_RETENTION_SWEEP || "").trim().toLowerCase() !== "on") {
      return { ran: false, phase: "SWEEP_DUE", reason: "retention-sweep-disabled-by-default" };
    }
    const st = await lifecycleState();
    if (st.phase !== "SWEEP_DUE") return { ran: false, phase: st.phase, reason: "phase-not-due" };
    if (st.paused) return { ran: false, phase: "SWEEP_DUE", reason: "paused-by-owner" };

    // شفافیت (ممیزی v1.1.2) — اگر OWNER_MOBILES تنظیم نباشد، هیچ حساب مالکی وجود ندارد
    // و مطابق قرارداد v1.1.0 همه حساب‌های ADMIN «غیرِ مالک» هستند (حذف می‌شوند؛ پرسنل حفظ).
    // این رفتار عمداً حفظ شده — تغییر آن قرارداد نسخه‌های قبل را می‌شکند (تست final-e2e).
    const ownerMobiles = (process.env.OWNER_MOBILES || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ownerMobiles.length === 0) {
      console.warn("vizito-retention: OWNER_MOBILES not set — all ADMIN accounts are treated as non-owner");
    }

    // ۱) پشتیبان — بدون پشتیبان معتبر هیچ حذفی انجام نمی‌شود
    let backupInfo: DeletedLog["backup"] = null;
    try {
      const b = await createBackup("MANUAL", {
        id: "system-retention",
        name: "سیستم — پایان مهلت تمدید لایسنس",
      });
      backupInfo = { id: b.id, fileName: b.fileName, sizeBytes: b.sizeBytes };
    } catch (e) {
      console.error("vizito-retention: backup failed — sweep aborted", e);
      return { ran: false, phase: "SWEEP_DUE", reason: "backup-failed" };
    }

    // ۲) شمارش قبل از حذف
    const counts = await countBusinessData();

    // ۳) حذف کنترل‌شده داخل یک تراکنش — حساب‌های مالک و پرسنل دست‌نخورده می‌مانند
    const deletedUsers = await db.$transaction(async (tx) => {
      await tx.payment.deleteMany({});
      await tx.orderItem.deleteMany({});
      await tx.order.deleteMany({});
      await tx.customer.deleteMany({});
      await tx.product.deleteMany({});
      await tx.productGroup.deleteMany({});
      // حذف حساب‌های ADMINِ مشتریِ نداده‌پرداز — حساب مالک (OWNER_MOBILES) حذف نمی‌شود
      return tx.user.deleteMany({
        where: { role: "ADMIN", ...(ownerMobiles.length ? { mobile: { notIn: ownerMobiles } } : {}) },
      });
    });
    // ابطال همه نشست‌ها — همه باید دوباره وارد شوند (داده‌های تجاری دیگر وجود ندارد)
    await db.authSession.deleteMany({});

    // ۴) لاگ گزارش‌پذیر — در دیتابیس + کنسول
    const log: DeletedLog = {
      at: new Date().toISOString(),
      trigger,
      counts: { ...counts, adminAccountsDeleted: deletedUsers.count },
      backup: backupInfo,
    };
    await db.setting.upsert({
      where: { key: DELETED_AT_KEY },
      update: { value: JSON.stringify(log) },
      create: { key: DELETED_AT_KEY, value: JSON.stringify(log) },
    });
    console.warn(
      "vizito-retention: controlled deletion done",
      JSON.stringify({ at: log.at, trigger, counts: log.counts, backup: log.backup })
    );
    return { ran: true, phase: "DELETED", deletedLog: log };
  } finally {
    sweepInFlight = false;
  }
}

/** تایمر چرخه حیات — از instrumentation.ts راه‌اندازی می‌شود (هر ۶ ساعت + یک بررسی تأخیری) */
let lifecycleTimerStarted = false;
export function startLifecycleScheduler(): void {
  if (lifecycleTimerStarted) return;
  lifecycleTimerStarted = true;
  const tick = () => {
    runDataRetentionSweep("timer").catch((e) => console.error("vizito-retention: timer error", e));
  };
  setTimeout(tick, 45_000).unref?.();
  setInterval(tick, 6 * 60 * 60 * 1000).unref?.();
}

/** کنترل‌های مالک روی چرخه حیات — توقف/ادامه حذف خودکار (فقط حساب مالک) */
export async function setRetentionPaused(paused: boolean, by: { id: string; name: string }): Promise<void> {
  void by;
  if (paused) {
    await db.setting.upsert({
      where: { key: RETENTION_PAUSED_KEY },
      update: { value: "1" },
      create: { key: RETENTION_PAUSED_KEY, value: "1" },
    });
  } else {
    await db.setting.deleteMany({ where: { key: RETENTION_PAUSED_KEY } });
  }
}

/** آیا این مدیر مالک است — برای گیت مسیرهای چرخه حیات (سمت سرور) */
export function assertOwnerAccess(mobile: string, isAdmin: boolean): boolean {
  return isAdmin && isOwnerMobile(mobile);
}

// re-export برای استفاده راحت در مسیرها
export { LICENSE_GRACE_MS };
