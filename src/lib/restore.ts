import crypto from "crypto";
import fs from "fs";
import { db } from "@/lib/db";
import { BACKUP_VERSION, decryptBackupEnvelope, safeBackupPath } from "@/lib/backup";

/**
 * بازیابی نسخه پشتیبان (Restore) — بخش دهم سند طراحی
 * -----------------------------------------------------------------------------
 * جریان: آپلود/انتخاب پاکت رمزشده → تأیید فرمت/نسخه → پیش‌نمایش شمارش‌ها →
 * تأیید دومرحله‌ای (رمز ادمین + تایپ نام) → جایگزینی تراکنشی.
 *
 * امنیت:
 *  - فقط مدیر (ORG_ADMIN برای مجموعه خودش، SUPER_ADMIN برای هر اسکوپ)
 *  - مدیر مجموعه هرگز بکاپ کامل سرور (FULL) یا مجموعه دیگر را نمی‌بیند — ۴۰۴ بدون افشا
 *  - کلید رمزگشایی فقط از env (BACKUP_ENCRYPTION_KEY) + نمک installId — پاکت نصب دیگر باز نمی‌شود
 *  - جایگزینی در یک تراکنش — شکست هر مرحله یعنی هیچ تغییری
 *  - پس از بازیابی، همه نشست‌های کاربرانِ تحت‌تأثیر باطل می‌شود (به‌جز نشست خودِ عملیات‌دهنده)
 *  - جداول عملیاتی (RateLimitBucket، AdminAccessLog، Backup و فایل‌ها) دست‌نخورده می‌مانند
 */

type AnyRow = Record<string, unknown>;

export class RestoreError extends Error {}

export type RestoreScope = "ORG" | "FULL";

export type ParsedBackup = {
  scope: RestoreScope;
  orgId: string | null;
  createdAt: string;
  tables: Record<string, AnyRow[]>;
};

/** جداول هر اسکوپ — ترتیبِ این فهرست‌ها همان ترتیب درج (والد قبل از فرزند) است */
const ORG_TABLES = [
  "productGroups",
  "products",
  "customers",
  "users",
  "accessGrants",
  "orders",
  "orderItems",
  "payments",
  "notifications",
  "messageRecipients",
] as const;

const FULL_TABLES = [
  "settings",
  "orgs",
  "users",
  "accessGrants",
  "productGroups",
  "products",
  "customers",
  "orders",
  "orderItems",
  "payments",
  "notifications",
  "messages",
  "messageRecipients",
  "licenseSales",
  "licenses",
  "licenseEvents",
  "licenseCharges",
  "supportThreads",
  "supportMessages",
  "devices",
] as const;

/** سقف حجم پاکت آپلودشده (مسیر «بازیابی از فایل») — بکاپ سروری خودش را مستقیم از دیسک می‌خواند */
export const MAX_RESTORE_UPLOAD_BYTES = 64 * 1024 * 1024;

/** عبارت تأیید اجباری برای بازیابی کامل سرور */
export const FULL_RESTORE_CONFIRM_PHRASE = "بازیابی کامل";

/** برچسب فارسی جداول — برای پیش‌نمایش UI */
export const TABLE_LABELS_FA: Record<string, string> = {
  users: "کاربران",
  accessGrants: "دسترسی‌ها",
  customers: "مشتریان",
  productGroups: "گروه‌های کالایی",
  products: "کالاها",
  orders: "سفارش‌ها",
  orderItems: "ردیف سفارش‌ها",
  payments: "تسویه‌ها",
  notifications: "اعلان‌ها",
  messageRecipients: "گیرندگان پیام",
  messages: "پیام‌های سازنده",
  licenseSales: "فروش لایسنس",
  licenseCharges: "شارژ لایسنس",
  settings: "تنظیمات",
  orgs: "مجموعه‌ها",
  licenses: "لایسنس‌ها",
  licenseEvents: "رویدادهای لایسنس",
  supportThreads: "رشته‌های پشتیبانی",
  supportMessages: "پیام‌های پشتیبانی",
  devices: "دستگاه‌ها",
};

/**
 * رمزگشایی و اعتبارسنجی ساختاری پاکت — هر نقض ⇒ RestoreError با پیام فارسی
 * (هیچ داده‌ای در این مرحله نوشته نمی‌شود)
 */
export function parseBackupEnvelope(text: string): ParsedBackup {
  if (!text || typeof text !== "string") throw new RestoreError("فایل پشتیبان خالی است");
  let raw: unknown;
  try {
    raw = JSON.parse(decryptBackupEnvelope(text));
  } catch (e) {
    if (e instanceof RestoreError) throw e;
    // رمزگشایی ناموفق = کلید/نصب متفاوت یا فایل خراب — پیام یکسان، بدون جزئیات
    throw new RestoreError("فایل پشتیبان معتبر نیست یا به این نصب تعلق ندارد");
  }
  if (!raw || typeof raw !== "object") throw new RestoreError("فایل پشتیبان معتبر نیست");
  const data = raw as Record<string, unknown>;

  const version = (data as { vizitoBackupVersion?: unknown }).vizitoBackupVersion;
  if (version !== BACKUP_VERSION) {
    throw new RestoreError("نسخه فایل پشتیبان با این نسخه برنامه سازگار نیست");
  }
  const scope = data.scope;
  if (scope !== "ORG" && scope !== "FULL") throw new RestoreError("فایل پشتیبان معتبر نیست");

  const tablesRaw = data.tables;
  if (!tablesRaw || typeof tablesRaw !== "object") throw new RestoreError("ساختار فایل پشتیبان ناقص است");

  const orgId = typeof data.orgId === "string" ? data.orgId : null;
  if (scope === "ORG" && !orgId) throw new RestoreError("فایل پشتیبان معتبر نیست");

  const tables: Record<string, AnyRow[]> = {};
  for (const key of FULL_TABLES) {
    const rows = (tablesRaw as Record<string, unknown>)[key];
    if (rows === undefined) {
      // بکاپ‌های قدیمی ORG فقط جداول ORG را دارند — برای FULL همه جداول الزامی است
      if (scope === "FULL") throw new RestoreError("ساختار فایل پشتیبان ناقص است");
      continue;
    }
    if (!Array.isArray(rows)) throw new RestoreError("ساختار فایل پشتیبان ناقص است");
    // هر ردیف باید شناسه متنی داشته باشد (به‌جز Setting که کلیدش خودش شناسه است)
    for (const row of rows) {
      if (!row || typeof row !== "object") throw new RestoreError("ساختار فایل پشتیبان ناقص است");
      if (key !== "settings" && typeof (row as AnyRow).id !== "string") {
        throw new RestoreError("ساختار فایل پشتیبان ناقص است");
      }
    }
    tables[key] = rows as AnyRow[];
  }
  if (scope === "ORG" && ORG_TABLES.some((k) => !tables[k])) {
    throw new RestoreError("ساختار فایل پشتیبان ناقص است");
  }
  const createdAt = typeof data.createdAt === "string" ? data.createdAt : "";
  return { scope, orgId, createdAt, tables };
}

/**
 * خواندن منبع بازیابی (شناسه بکاپ سروری یا متن پاکت آپلودی) + گیت دسترسی اسکوپ.
 * مدیر مجموعه: فقط بکاپ ORG مجموعه خودش — بکاپ FULL یا مجموعه دیگر ⇒ ۴۰۴ بدون افشا.
 */
export async function readRestoreSource(opts: {
  id?: string;
  file?: string;
  ctxOrgId: string | null;
  isSuperAdmin: boolean;
}): Promise<{ parsed: ParsedBackup } | { error: Response }> {
  const bad = (message: string, status = 400) => ({ error: Response.json({ error: message }, { status }) });
  const notFound = () => bad("نسخه پشتیبان یافت نشد", 404);

  let text = "";
  if (opts.id) {
    const row = await db.backup.findUnique({ where: { id: opts.id } });
    // چندمجموعه‌ای: مدیر مجموعه فقط بکاپ مجموعه خودش؛ بکاپ کامل سرور (orgId=null)
    // برای سازنده همیشه در دسترس است — حتی وقتی «مجموعه من» دارد (فاز D)
    if (
      !row ||
      (opts.ctxOrgId && row.orgId !== opts.ctxOrgId && !(opts.isSuperAdmin && row.orgId === null)) ||
      (!opts.ctxOrgId && !opts.isSuperAdmin)
    ) {
      return notFound();
    }
    const p = safeBackupPath(row.fileName);
    if (!p || !fs.existsSync(p)) return bad("فایل نسخه پشتیبان روی سرور یافت نشد");
    text = fs.readFileSync(p, "utf8");
  } else if (opts.file) {
    if (opts.file.length > MAX_RESTORE_UPLOAD_BYTES) {
      return bad("حجم فایل پشتیبان بیش از سقف مجاز است", 413);
    }
    text = opts.file;
  } else {
    return bad("شناسه نسخه پشتیبان یا فایل پشتیبان لازم است");
  }

  let parsed: ParsedBackup;
  try {
    parsed = parseBackupEnvelope(text);
  } catch (e) {
    return bad(e instanceof RestoreError ? e.message : "فایل پشتیبان معتبر نیست");
  }
  // گیت اسکوپ روی «محتوای واقعی» پاکت — نه فقط روی ردیف دیتابیس
  if (!opts.isSuperAdmin) {
    if (parsed.scope === "FULL" || parsed.orgId !== opts.ctxOrgId) return notFound();
  }
  return { parsed };
}

/** هشدارهای پیش از بازیابی — برای پیش‌نمایش UI */
export async function buildRestoreWarnings(parsed: ParsedBackup): Promise<string[]> {
  const warnings: string[] = [];
  if (parsed.scope === "FULL") {
    warnings.push("تمام داده‌های فعلی سرور — همه مجموعه‌ها، کاربران و لایسنس‌ها — با محتوای این نسخه جایگزین می‌شود.");
  }
  // گیرندگان پیامی که پیامِ آن‌ها (پیام سازنده) در سرور فعلی وجود ندارد —
  // در بکاپ مجموعه هستند ولی پیام مرجع بیرون اسکوپ است؛ این ردیف‌ها نادیده گرفته می‌شوند
  const recipients = parsed.tables.messageRecipients || [];
  if (recipients.length > 0) {
    const msgIds = new Set((await db.message.findMany({ select: { id: true } })).map((m) => m.id));
    const orphan = recipients.filter((r) => !msgIds.has(String(r.messageId))).length;
    if (orphan > 0) {
      warnings.push(`${orphan} گیرندهٔ پیام به پیامی حذف‌شده اشاره می‌کند و بازیابی نمی‌شود.`);
    }
  }
  return warnings;
}

export type KeepSession = {
  tokenHash: string;
  userId: string;
  userAgent: string | null;
  expiresAt: Date;
};

export type RestoreResult = {
  scope: RestoreScope;
  restored: Record<string, number>;
  sessionsRevoked: number;
};

/**
 * جایگزینی تراکنشی داده‌ها با محتوای پاکت — شناسه‌ها و زمان‌ها عیناً حفظ می‌شوند.
 * نشست عملیات‌دهنده (keepSession) باقی می‌ماند؛ بقیه نشست‌های تحت‌تأثیر باطل می‌شوند.
 * نکته: حذف کاربران در سطح DB نشست‌هایشان را Cascade می‌کند — نشست عملیات‌دهنده
 * قبل از حذف ضبط و بعد از درج مجدد کاربران بازساخته می‌شود.
 */
export async function applyRestore(
  parsed: ParsedBackup,
  opts: { keepSession?: KeepSession | null; actorId?: string; actorName?: string | null }
): Promise<RestoreResult> {
  const t = parsed.tables;
  const restored: Record<string, number> = {};
  let sessionsRevoked = 0;

  if (parsed.scope === "ORG") {
    const orgId = parsed.orgId as string;
    await db.$transaction(async (tx) => {
      // کاربرانِ تحت‌تأثیر = کاربران فعلی مجموعه + کاربران داخل پاکت (همان مجموعه)
      const currentUserIds = (await tx.user.findMany({ where: { orgId }, select: { id: true } })).map((r) => r.id);
      const backupUserIds = (t.users || []).map((r) => String(r.id));
      const affected = Array.from(new Set([...currentUserIds, ...backupUserIds]));
      // شمارش نشست‌های تحت‌تأثیر قبل از هر حذفی (حذف کاربر ⇒ Cascade نشست)
      const sessionsBefore = await tx.authSession.count({ where: { userId: { in: affected } } });

      // ── حذف داده‌های فعلی مجموعه (فرزند قبل از والد) ──
      await tx.payment.deleteMany({ where: { orgId } });
      await tx.orderItem.deleteMany({ where: { order: { orgId } } });
      await tx.order.deleteMany({ where: { orgId } });
      await tx.notification.deleteMany({ where: { user: { orgId } } });
      await tx.messageRecipient.deleteMany({ where: { user: { orgId } } });
      await tx.accessGrant.deleteMany({ where: { user: { orgId } } });
      await tx.user.deleteMany({ where: { orgId } });
      await tx.customer.deleteMany({ where: { orgId } });
      await tx.product.deleteMany({ where: { orgId } });
      await tx.productGroup.deleteMany({ where: { orgId } });

      // ── درج از پاکت (والد قبل از فرزند) — orgId همیشه اجباری به مجموعه هدف ──
      await tx.productGroup.createMany({ data: forceOrg(t.productGroups, orgId) as any });
      await tx.product.createMany({ data: forceOrg(t.products, orgId) as any });
      await tx.customer.createMany({ data: forceOrg(t.customers, orgId) as any });
      await tx.user.createMany({ data: forceOrg(t.users, orgId) as any });
      await tx.accessGrant.createMany({ data: t.accessGrants as any });
      await tx.order.createMany({ data: forceOrg(t.orders, orgId) as any });
      await tx.orderItem.createMany({ data: t.orderItems as any });
      await tx.payment.createMany({ data: forceOrg(t.payments, orgId) as any });
      await tx.notification.createMany({ data: t.notifications as any });

      // گیرندگان پیام — فقط ردیف‌هایی که پیام مرجعشان الان وجود دارد
      const msgIds = new Set((await tx.message.findMany({ select: { id: true } })).map((m) => m.id));
      const mr = (t.messageRecipients || []).filter((r) => msgIds.has(String(r.messageId)));
      await tx.messageRecipient.createMany({ data: mr as any });

      // ابطال صریح نشست‌های تحت‌تأثیر — به‌جز نشست عملیات‌دهنده (که Cascade حذف کاربران آن را هم می‌برد)
      await tx.authSession.deleteMany({
        where: {
          userId: { in: affected },
          ...(opts.keepSession ? { tokenHash: { not: opts.keepSession.tokenHash } } : {}),
        },
      });

      for (const k of ORG_TABLES) restored[k] = k === "messageRecipients" ? mr.length : (t[k] || []).length;

      // بازسازی نشست عملیات‌دهنده — فقط اگر حساب او داخل پاکت باشد (مدیر همان مجموعه)
      const keepOk =
        !!opts.keepSession && backupUserIds.includes(opts.keepSession.userId);
      if (keepOk && opts.keepSession) {
        await tx.authSession.create({ data: opts.keepSession });
      }
      sessionsRevoked = sessionsBefore - (keepOk ? 1 : 0);
    }, { maxWait: 5000, timeout: 15000 });
    return { scope: "ORG", restored, sessionsRevoked };
  }

  // ── FULL — فقط سازنده؛ جایگزینی کامل سرور ──
  await db.$transaction(async (tx) => {
    const sessionsBefore = await tx.authSession.count();
    // حذف (فرزند قبل از والد — ترتیب FKها)
    await tx.licenseCharge.deleteMany({});
    await tx.licenseSale.deleteMany({});
    await tx.supportMessage.deleteMany({});
    await tx.supportThread.deleteMany({});
    await tx.device.deleteMany({});
    await tx.licenseEvent.deleteMany({});
    await tx.license.deleteMany({});
    await tx.messageRecipient.deleteMany({});
    await tx.message.deleteMany({});
    await tx.notification.deleteMany({});
    await tx.payment.deleteMany({});
    await tx.orderItem.deleteMany({});
    await tx.order.deleteMany({});
    await tx.accessGrant.deleteMany({});
    await tx.authSession.deleteMany({
      where: opts.keepSession ? { tokenHash: { not: opts.keepSession.tokenHash } } : {},
    });
    await tx.user.deleteMany({});
    await tx.customer.deleteMany({});
    await tx.product.deleteMany({});
    await tx.productGroup.deleteMany({});
    await tx.org.deleteMany({});
    await tx.setting.deleteMany({});

    // درج (والد قبل از فرزند)
    await tx.setting.createMany({ data: t.settings as any });
    await tx.org.createMany({ data: t.orgs as any });
    await tx.user.createMany({ data: t.users as any });
    await tx.accessGrant.createMany({ data: t.accessGrants as any });
    await tx.productGroup.createMany({ data: t.productGroups as any });
    await tx.product.createMany({ data: t.products as any });
    await tx.customer.createMany({ data: t.customers as any });
    await tx.order.createMany({ data: t.orders as any });
    await tx.orderItem.createMany({ data: t.orderItems as any });
    await tx.payment.createMany({ data: t.payments as any });
    await tx.notification.createMany({ data: t.notifications as any });
    await tx.message.createMany({ data: t.messages as any });
    // گیرندگان پیام در FULL همیشه سازگارند (پیام‌ها هم داخل پاکت‌اند) — فیلتر دفاعی حفظ شد
    const msgIds = new Set((await tx.message.findMany({ select: { id: true } })).map((m) => m.id));
    await tx.messageRecipient.createMany({
      data: (t.messageRecipients || []).filter((r) => msgIds.has(String(r.messageId))) as any,
    });
    await tx.licenseSale.createMany({ data: t.licenseSales as any });
    await tx.license.createMany({ data: t.licenses as any });
    await tx.licenseEvent.createMany({ data: t.licenseEvents as any });
    await tx.licenseCharge.createMany({ data: t.licenseCharges as any });
    await tx.supportThread.createMany({ data: t.supportThreads as any });
    await tx.supportMessage.createMany({ data: t.supportMessages as any });
    await tx.device.createMany({ data: t.devices as any });

    for (const k of FULL_TABLES) restored[k] = (t[k] || []).length;

    // بازسازی نشست عملیات‌دهنده — فقط اگر حساب او داخل پاکت باشد
    const keepOk = !!opts.keepSession && (t.users || []).some((r) => String(r.id) === opts.keepSession!.userId);
    if (keepOk && opts.keepSession) {
      await tx.authSession.create({ data: opts.keepSession });
    }
    sessionsRevoked = sessionsBefore - (keepOk ? 1 : 0);
  }, { maxWait: 5000, timeout: 15000 });

  // حسابرسی خارج از تراکنش — شکست ثبت لاگ نباید بازیابی را برگرداند
  if (opts.actorId) {
    await db.adminAccessLog
      .create({
        data: {
          actorId: opts.actorId,
          actorName: opts.actorName ?? null,
          orgId: null,
          action: "RESTORE_FULL",
          detail: JSON.stringify({ counts: restored }),
        },
      })
      .catch(() => {});
  }
  console.log("vizito restore: FULL backup applied —", Object.keys(restored).length, "tables restored");
  return { scope: "FULL", restored, sessionsRevoked };
}

/** اعمال اجباری orgId روی ردیف‌های اسکوپ مجموعه — ضد پاکت دستکاری‌شده */
function forceOrg(rows: AnyRow[] | undefined, orgId: string): AnyRow[] {
  return (rows || []).map((r) => ({ ...r, orgId }));
}

/** هش نشست فعلی برای نگه‌داشتن عملیات‌دهنده — همان الگوریتم auth.ts */
export function sessionHashOf(token: string | null): string | null {
  if (!token) return null;
  return crypto.createHash("sha256").update(token).digest("hex");
}
