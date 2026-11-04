import fs from "fs";
import path from "path";
import crypto from "crypto";
import { db } from "@/lib/db";
import { getInstallId } from "@/lib/license";

/**
 * سیستم پشتیبان‌گیری ویزیتو — فقط مدیر
 * - فایل پشتیبان به صورت JSON رمزنگاری‌شده ذخیره می‌شود (خارج از پوشه public)
 *   ⇒ هیچ آدرس عمومی‌ای برای دانلود فایل‌ها وجود ندارد؛ دانلود فقط با توکن مدیر از مسیر API
 * - نام فایل همیشه سمت سرور تولید می‌شود (هیچ ورودی کاربری در مسیر فایل استفاده نمی‌شود)
 * - نگهداری محدود: نسخه‌های قدیمی‌تر هر نوع به‌صورت خودکار پاک می‌شوند
 * - مسیر ذخیره: VIZITO_DATA_DIR/backups — در production (cPanel) این متغیر باید
 *   به مسیری «مطلق» بیرون از پوشه عمومی سایت تنظیم شود تا با جایگزینی فایل‌های
 *   برنامه هنگام Deploy از بین نرود؛ اگر تنظیم نشده باشد (فقط توسعه): <cwd>/db/backups
 */

function dataRoot(): string {
  const dir = (process.env.VIZITO_DATA_DIR || "").trim();
  return dir || path.join(process.cwd(), "db");
}

export const BACKUP_DIR = path.join(dataRoot(), "backups");
export const BACKUP_VERSION = 1;

export const BACKUP_KINDS = ["MANUAL", "DAILY", "WEEKLY", "MONTHLY"] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

export const SCHEDULE_VALUES = ["off", "daily", "weekly", "monthly"] as const;
export type ScheduleValue = (typeof SCHEDULE_VALUES)[number];

const SCHEDULE_KEY = "backup_schedule";

/** فاصله زمانی هر نوع پشتیبان خودکار */
export const AUTO_INTERVAL_MS: Record<Exclude<ScheduleValue, "off">, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

/** حداکثر تعداد نگهداری هر نوع */
const KEEP_COUNT: Record<BackupKind, number> = {
  MANUAL: 20,
  DAILY: 10,
  WEEKLY: 6,
  MONTHLY: 12,
};

export function isBackupKind(v: unknown): v is BackupKind {
  return typeof v === "string" && (BACKUP_KINDS as readonly string[]).includes(v);
}

export function isScheduleValue(v: unknown): v is ScheduleValue {
  return typeof v === "string" && (SCHEDULE_VALUES as readonly string[]).includes(v);
}

function ensureDir(): void {
  // ممیزی v1.1.2 — دسترسی محدود پوشه (0o700): روی هاست اشتراکی، فایل‌های پشتیبان
  // رمزنگاری‌شده نباید برای سایر مستأجرها خواندنی باشند
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
}

/** حذف فایل با ثبت خطا (بدون مسیر مطلق در لاگ) — حذف هرگز بی‌صدا شکست نمی‌خورد */
async function rmFile(p: string): Promise<void> {
  try {
    await fs.promises.rm(p, { force: true });
  } catch (e) {
    console.error("backup file delete failed:", path.basename(p), (e as Error)?.message || e);
  }
}

/** مسیر امن فایل — نام فایل فقط از دیتابیس می‌آید و هیچ «/» یا «..» پذیرفته نیست */
export function safeBackupPath(fileName: string): string | null {
  if (!fileName || fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) return null;
  const p = path.join(BACKUP_DIR, fileName);
  if (!p.startsWith(BACKUP_DIR)) return null;
  return p;
}

export async function getSchedule(): Promise<ScheduleValue> {
  const row = await db.setting.findUnique({ where: { key: SCHEDULE_KEY } });
  return isScheduleValue(row?.value) ? row!.value : "off";
}

export async function setSchedule(value: ScheduleValue): Promise<void> {
  await db.setting.upsert({
    where: { key: SCHEDULE_KEY },
    update: { value },
    create: { key: SCHEDULE_KEY, value },
  });
}

/** جمع‌آوری کامل داده‌های برنامه برای فایل پشتیبان */
async function collectData() {
  // امنیت: authSessions (هش توکن‌های فعال) هرگز در بکاپ نمی‌آید — نشست‌ها قابل بازسازی نیستند و لازم نیست
  // ممیزی v1.1.2 — Message/MessageRecipient هم در بکاپ می‌آیند؛ نبودِ آن‌ها یعنی
  // هر بازیابی، تاریخ پیام‌ها و وضعیت خوانده‌شدن را برای همیشه از دست می‌داد
  const [users, accessGrants, customers, productGroups, products, orders, orderItems, payments, notifications, licenseSales, licenseCharges, settings, messages, messageRecipients] = await Promise.all([
    db.user.findMany(),
    db.accessGrant.findMany(),
    db.customer.findMany(),
    db.productGroup.findMany(),
    db.product.findMany(),
    db.order.findMany(),
    db.orderItem.findMany(),
    db.payment.findMany(),
    db.notification.findMany(),
    db.licenseSale.findMany(),
    db.licenseCharge.findMany(),
    db.setting.findMany(),
    db.message.findMany(),
    db.messageRecipient.findMany(),
  ]);
  return {
    vizitoBackupVersion: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    tables: { users, accessGrants, customers, productGroups, products, orders, orderItems, payments, notifications, licenseSales, licenseCharges, settings, messages, messageRecipients },
  };
}

function countOf(data: Awaited<ReturnType<typeof collectData>>): string {
  const t = data.tables;
  return JSON.stringify({
    users: t.users.length,
    customers: t.customers.length,
    products: t.products.length,
    orders: t.orders.length,
    payments: t.payments.length,
    messages: t.messages.length,
  });
}

// ---------- رمزنگاری فایل پشتیبان (AES-256-GCM) ----------
// امنیت: کلید رمزنگاری «فقط» از env: BACKUP_ENCRYPTION_KEY ساخته می‌شود (حداقل ۳۲ کاراکتر).
// مقادیر عمومی برنامه (کلید عمومی لایسنس) یا مقادیری که داخل خود فایل بکاپ هستند (installId)
// هرگز به‌عنوان کلید استفاده نمی‌شوند — وگرنه هر کسی فایل بکاپ را داشته باشد می‌تواند رمزگشایی کند.
// شناسه نصب داخل پاکت فقط به‌عنوان نمک (salt) ذخیره می‌شود، نه راز.

export const BACKUP_ENVELOPE_FMT = "VIZITO-ENC-2";

type BackupEnvelope = {
  fmt: string;
  installId: string;
  iv: string;
  tag: string;
  data: string; // base64
  createdAt: string;
};

function backupKey(installId: string): Buffer {
  const secret = process.env.BACKUP_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error("BACKUP_ENCRYPTION_KEY الزامی است (حداقل ۳۲ کاراکتر) — روی سرور تنظیم کنید");
  }
  return crypto.scryptSync(secret, `vizito-backup::${installId}`, 32);
}

function encryptBackup(dataJson: string, installId: string): BackupEnvelope {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", backupKey(installId), iv);
  const enc = Buffer.concat([cipher.update(dataJson, "utf8"), cipher.final()]);
  return {
    fmt: BACKUP_ENVELOPE_FMT,
    installId,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: enc.toString("base64"),
    createdAt: new Date().toISOString(),
  };
}

/** رمزگشایی فایل پشتیبان (برای بازیابی/اسکریپت) — فرمت قدیمیِ بدون رمز هم پذیرفته می‌شود */
export function decryptBackupEnvelope(text: string): string {
  const parsed = JSON.parse(text) as Partial<BackupEnvelope> & { vizitoBackupVersion?: number; tables?: unknown };
  if (parsed.fmt !== BACKUP_ENVELOPE_FMT || !parsed.iv || !parsed.tag || !parsed.data || !parsed.installId) {
    // فرمت قدیمی (بدون رمزنگاری)
    if (parsed.vizitoBackupVersion || parsed.tables) return text;
    throw new Error("فایل پشتیبان شناخته نشد");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", backupKey(parsed.installId), Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const dec = Buffer.concat([decipher.update(Buffer.from(parsed.data, "base64")), decipher.final()]);
  return dec.toString("utf8");
}

/** ساخت نسخه پشتیبان جدید و بازگرداندن متادیتای آن */
export async function createBackup(
  kind: BackupKind,
  by?: { id: string; name: string } | null
): Promise<{ id: string; kind: string; fileName: string; sizeBytes: number; createdAt: Date; counts: string; createdByName: string | null }> {
  ensureDir();
  const data = await collectData();
  const installId = await getInstallId();
  const envelope = encryptBackup(JSON.stringify(data), installId);
  const buf = Buffer.from(JSON.stringify(envelope), "utf8");
  // نام فایل کاملاً سمت سرور تولید می‌شود
  // ممیزی v1.1.2 — نوشتن اتمیک: ابتدا فایل موقت (مجوز 0o600) و سپس rename؛
  // دیسکِ پر یا خطای نوشتن دیگر هرگز «فایل ناقص» با نام نهایی باقی نمی‌گذارد و
  // شکست ثبت در دیتابیس هم فایل یتیم باقی نمی‌گذارد
  const fileName = `vizito-${kind.toLowerCase()}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.json`;
  const finalPath = path.join(BACKUP_DIR, fileName);
  const tmpPath = finalPath + ".tmp";
  try {
    fs.writeFileSync(tmpPath, buf, { mode: 0o600 });
    fs.renameSync(tmpPath, finalPath);
    const row = await db.backup.create({
      data: {
        kind,
        fileName,
        sizeBytes: buf.length,
        counts: countOf(data),
        createdBy: kind === "MANUAL" ? by?.id ?? null : null,
        createdByName: kind === "MANUAL" ? by?.name?.slice(0, 80) ?? null : null,
      },
    });
    await pruneOld(kind);
    return row;
  } catch (e) {
    // هیچ فایل ناقص/یتیمی باقی نمی‌ماند — خطا به مسیر اصلی (API/زمان‌بند) برمی‌گردد
    try {
      fs.rmSync(finalPath, { force: true });
    } catch {}
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {}
    throw e;
  }
}

/** حذف نسخه‌های قدیمی‌تر از سقف نگهداری (فایل + ردیف) */
async function pruneOld(kind: BackupKind): Promise<void> {
  try {
    const old = await db.backup.findMany({
      where: { kind },
      orderBy: { createdAt: "desc" },
      skip: KEEP_COUNT[kind],
    });
    for (const row of old) {
      const p = safeBackupPath(row.fileName);
      if (p) await rmFile(p);
    }
    if (old.length > 0) {
      await db.backup.deleteMany({ where: { id: { in: old.map((r) => r.id) } } });
    }
  } catch {
    // prune مشکلی برای عملکرد اصلی ایجاد نمی‌کند
  }
}

/** حذف یک نسخه پشتیبان (فایل + ردیف) */
export async function deleteBackup(id: string): Promise<boolean> {
  const row = await db.backup.findUnique({ where: { id } });
  if (!row) return false;
  const p = safeBackupPath(row.fileName);
  if (p) await rmFile(p);
  await db.backup.delete({ where: { id } });
  return true;
}

/** حذف همه نسخه‌های پشتیبان (برای پاک‌سازی کامل برنامه) */
export async function deleteAllBackups(): Promise<void> {
  const rows = await db.backup.findMany();
  for (const row of rows) {
    const p = safeBackupPath(row.fileName);
    if (p) await rmFile(p);
  }
  await db.backup.deleteMany();
}

/** آخرین پشتیبان خودکار هر نوع */
export async function lastAutoBackups() {
  const rows = await db.backup.findMany({
    where: { kind: { in: ["DAILY", "WEEKLY", "MONTHLY"] } },
    orderBy: { createdAt: "desc" },
  });
  const out: Record<string, string | null> = { DAILY: null, WEEKLY: null, MONTHLY: null };
  for (const r of rows) if (!out[r.kind]) out[r.kind] = r.createdAt.toISOString();
  return out;
}

let tickInFlight = false;

/**
 * یک تیک زمان‌بند: اگر پشتیبان‌گیری خودکار فعال باشد و زمانش رسیده باشد، نسخه جدید می‌سازد.
 * روی حالت خاموش یا برنامه خالی (بدون کاربر) هیچ کاری نمی‌کند.
 */
export async function schedulerTick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const schedule = await getSchedule();
    if (schedule === "off") return;
    const userCount = await db.user.count();
    if (userCount === 0) return; // برنامه خالی (راه‌اندازی اولیه) — پشتیبان بی‌معناست
    const last = await db.backup.findFirst({
      where: { kind: schedule.toUpperCase() },
      orderBy: { createdAt: "desc" },
    });
    const interval = AUTO_INTERVAL_MS[schedule];
    if (last && Date.now() - last.createdAt.getTime() < interval) return;
    await createBackup(schedule.toUpperCase() as BackupKind, null);
  } catch (e) {
    console.error("backup scheduler error", e);
  } finally {
    tickInFlight = false;
  }
}

/** شروع حلقه زمان‌بند (هر ۶۰ ثانیه) — فقط یک‌بار در طول عمر پروسه */
export function startBackupScheduler(): void {
  const g = globalThis as unknown as { __vizitoSchedulerStarted?: boolean };
  if (g.__vizitoSchedulerStarted) return;
  g.__vizitoSchedulerStarted = true;
  setInterval(() => {
    schedulerTick().catch(() => {});
  }, 60_000);
  // تیک اول با کمی تأخیر تا راه‌اندازی سرور کامل شود
  setTimeout(() => {
    schedulerTick().catch(() => {});
  }, 15_000);
}
