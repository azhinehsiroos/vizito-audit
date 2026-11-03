#!/usr/bin/env node
"use strict";

/**
 * ---------------------------------------------------------------------------
 * scripts/migrate-sqlite.cjs — اجرای مهاجرت‌های Prisma روی SQLite بدون Prisma CLI
 * ---------------------------------------------------------------------------
 * چرا این اسکریپت؟
 *  روی cPanel ما به Prisma CLI (≈۱۰۰MB وابستگی + موتور schema + دسترسی شبکه به
 *  binaries.prisma.sh) دسترسی مطمئن نداریم و نصب on-demand ممکن نیست. فایل‌های
 *  مهاجرت ما SQL خالص SQLite هستند (پوشه prisma/migrations، فایل migration.sql هر پوشه)
 *  و Node.js 24 ماژول داخلی node:sqlite را دارد ⇒ همین اسکریپت با «صفر وابستگی» همان کار
 *  migrate deploy را انجام می‌دهد و با جدول _prisma_migrations سازگار است:
 *   - مهاجرتِ اعمال‌نشده ⇒ اجرا + ثبت ردیف (سازگار با خروجی prisma migrate status)
 *   - مهاجرتِ قبلاً اعمال‌شده (طبق جدول) ⇒ نادیده گرفته می‌شود
 *   - دیتابیسی که با «db push» ساخته شده (جدول‌ها هست ولی رکورد مهاجرت نیست)
 *     ⇒ «baseline»: تراکنش برمی‌گردد (ROLLBACK)، فقط ثبت می‌شود و «هیچ داده‌ای
 *     دست نمی‌خورد» (تشخیص از خطای «already exists»)
 *   - خطای دیگر ⇒ شکست صریح (سرور بالا نمی‌آید تا با ساختار ناسازگار بالا نیاید)
 *
 * امنیت داده:
 *  - هر مهاجرت داخل BEGIN…COMMIT اجرا می‌شود ⇒ هرگز اجرای نیمه‌کاره نداریم
 *  - این اسکریپت هرگز DROP/DELETE/RESET انجام نمی‌دهد و به داده‌ها دست نمی‌زند
 *  - دستورهای ممنوعه (migrate reset / db push --accept-data-loss) اینجا وجود ندارند
 *
 * استفاده: از server.cjs به‌صورت require — یا مستقیم:
 *   node scripts/migrate-sqlite.cjs
 * (DATABASE_URL باید file:<مسیر مطلق> باشد)
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// جدول مهاجرت‌ها با ساختارِ خود Prisma — تا prisma migrate status/deploy بعداً هم سازگار بماند
const PRISMA_MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" VARCHAR(36) NOT NULL PRIMARY KEY,
  "checksum" VARCHAR(64) NOT NULL,
  "finished_at" DATETIME,
  "migration_name" VARCHAR(255) NOT NULL,
  "logs" TEXT,
  "rolled_back_at" DATETIME,
  "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
)`;

// جدول‌های کلیدی اسکیمای فعلی — پس از مهاجرت باید همگی موجود باشند (سلامت‌سنجی)
const REQUIRED_TABLES = [
  "User",
  "AuthSession",
  "AccessGrant",
  "Customer",
  "ProductGroup",
  "Product",
  "Order",
  "OrderItem",
  "Payment",
  "Setting",
  "RateLimitBucket",
  "Notification",
  "LicenseSale",
  "LicenseCharge",
  "Backup",
];

function log(msg) {
  console.log("[vizito-db] " + msg);
}
function warn(msg) {
  console.warn("[vizito-db] ⚠ " + msg);
}

function resolveDbFile(explicit) {
  const url = (explicit || process.env.DATABASE_URL || "").trim();
  if (!url) throw new Error("DATABASE_URL تنظیم نشده است");
  if (!url.startsWith("file:")) throw new Error("DATABASE_URL باید با file: شروع شود (SQLite)");
  let p = url.slice("file:".length).split("?")[0].trim();
  if (!p) throw new Error("مسیر دیتابیس در DATABASE_URL خالی است");
  if (!path.isAbsolute(p)) throw new Error("مسیر دیتابیس باید مطلق باشد (خطای نسبی: " + p + ")");
  return p;
}

/** فقط برای baseline: تشخیص «شیء از قبل وجود دارد» از متن خطای SQLite */
function isAlreadyExistsError(e) {
  const m = String((e && e.message) || e);
  return /already exists/i.test(m);
}

/**
 * اجرای همه مهاجرت‌های در انتظار. بدون بازگشت مقدار؛ خطا ⇒ throw (سرور متوقف می‌شود)
 * @param {{dbFile?: string, migrationsDir?: string}} opts
 */
function runMigrations(opts = {}) {
  const dbFile = opts.dbFile || resolveDbFile();
  const migrationsDir = opts.migrationsDir || path.join(__dirname, "..", "prisma", "migrations");
  const dbDir = path.dirname(dbFile);
  fs.mkdirSync(dbDir, { recursive: true });

  // node:sqlite — داخلی Node.js 24 (بدون هیچ وابستگی خارجی)
  const { DatabaseSync } = require("node:sqlite");
  const dbo = new DatabaseSync(dbFile);
  try {
    dbo.exec("PRAGMA journal_mode = WAL;");
    dbo.exec("PRAGMA busy_timeout = 10000;");
    dbo.exec(PRISMA_MIGRATIONS_TABLE_SQL);

    // فهرست مهاجرت‌ها به ترتیب نام (پیشوند زمانی YYYYMMDDHHMMSS)
    const dirs = fs
      .readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d{14}_/.test(d.name))
      .map((d) => d.name)
      .sort();
    if (dirs.length === 0) warn("هیچ پوشه مهاجرتی پیدا نشد: " + migrationsDir);

    let applied = 0;
    let baselined = 0;
    for (const name of dirs) {
      // رکورد قبلی؟ (اعمال‌شده یا baseline‌شده) ⇒ رد شود
      const rec = dbo.prepare("SELECT 1 FROM \"_prisma_migrations\" WHERE migration_name = ? AND rolled_back_at IS NULL").get(name);
      if (rec) continue;

      const sqlPath = path.join(migrationsDir, name, "migration.sql");
      if (!fs.existsSync(sqlPath)) {
        throw new Error("فایل migration.sql برای «" + name + "» پیدا نشد");
      }
      const sql = fs.readFileSync(sqlPath, "utf8");
      const checksum = crypto.createHash("sha256").update(sql).digest("hex");
      const started = new Date().toISOString().replace("T", " ").replace("Z", "");

      dbo.exec("BEGIN");
      try {
        dbo.exec(sql);
        dbo.exec("COMMIT");
        applied++;
        log("مهاجرت اعمال شد: " + name);
      } catch (e) {
        try {
          dbo.exec("ROLLBACK");
        } catch {}
        if (isAlreadyExistsError(e)) {
          // دیتابیس با db push ساخته شده و این مهاجرت عملاً قبلاً اعمال شده ⇒ فقط ثبت (baseline)
          // هیچ داده‌ای تغییر نمی‌کند — تراکنش کامل ROLLBACK شده است
          baselined++;
          warn("baseline: ساختار «" + name + "» از قبل موجود بود — فقط ثبت شد (داده‌ها دست نخوردند)");
        } else {
          throw new Error("اجرای مهاجرت «" + name + "» ناموفق بود: " + (e && e.message));
        }
      }

      dbo.prepare(
        `INSERT INTO "_prisma_migrations"
           ("id","checksum","finished_at","migration_name","logs","rolled_back_at","started_at","applied_steps_count")
         VALUES (?,?,?,?,?,NULL,?,1)`
      ).run(
        crypto.randomUUID(),
        checksum,
        new Date().toISOString().replace("T", " ").replace("Z", ""),
        name,
        baselined > 0 && applied > 0 ? "" : baselined > 0 ? "baselined: objects already existed" : "",
        started
      );
    }

    // سلامت‌سنجی نهایی — جدول‌های کلیدی اسکیما باید موجود باشند
    const missing = [];
    for (const t of REQUIRED_TABLES) {
      const row = dbo.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(t);
      if (!row) missing.push(t);
    }
    if (missing.length > 0) {
      throw new Error(
        "پس از مهاجرت، جدول‌های کلیدی موجود نیستند: " + missing.join(", ") +
          " — دیتابیس با اسکیمای برنامه همخوان نیست؛ از نسخه پشتیبان استفاده کنید"
      );
    }

    log(
      "مهاجرت‌ها به‌روز است ✔" +
        (applied ? " (اعمال‌شده: " + applied + ")" : "") +
        (baselined ? " (baseline ثبت‌شده: " + baselined + ")" : "")
    );
  } finally {
    dbo.close();
  }
}

module.exports = { runMigrations, resolveDbFile };

// اجرای مستقیم از خط فرمان (node scripts/migrate-sqlite.cjs)
if (require.main === module) {
  try {
    runMigrations();
  } catch (e) {
    console.error("[vizito-db] ✖ " + (e && e.message));
    process.exit(1);
  }
}
