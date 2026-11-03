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
 *  migrate deploy را انجام می‌دهد و با جدول _prisma_migrations سازگار است.
 *
 * Baseline ساختاری (ممیزی v1.0.10 — جایگزین تشخیص خطای عمومی «already exists»):
 *  دیتابیس‌هایی که با «db push» ساخته شده‌اند ساختارِ نهایی دارند ولی رکورد مهاجرت
 *  ندارند. برای این‌ها به‌جای حدس زدن از روی متن خطا:
 *   ۱) همه مهاجرت‌ها به‌ترتیب روی یک دیتابیس «در حافظه» بازپخش می‌شوند و پس از
 *      هر مرحله «عکس ساختاری» گرفته می‌شود: جدول‌ها، ستون‌ها (نام/نوع/NOT NULL/
 *      DEFAULT/PK)، کلیدهای خارجی (جدول مرجع/ستون/ON DELETE/ON UPDATE) و
 *      indexها (یکتا/عادی/ستون‌ها) — با نرمال‌سازی حاشیه‌ای.
 *   ۲) ساختار دیتابیس واقعی با این وضعیت‌های میانی مقایسه می‌شود:
 *      - تطبیق با مرحله k ⇒ مهاجرت‌های k+1 به بعد اجرا می‌شوند؛ مراحل قبل فقط ثبت
 *      - تطبیق با مرحله آخر (k=N) ⇒ هیچ SQL اجرا نمی‌شود؛ فقط رکوردهای «baseline»
 *      - عدم تطبیق با «هیچ» مرحله‌ای ⇒ توقف کامل بدون هیچ تغییری در داده‌ها
 *   ۳) پس از اجرای هر مهاجرت، ساختار جدید دوباره گرفته و با وضعیت مورد انتظار
 *      مقایسه می‌شود — مغایرت ⇒ ROLLBACK و توقف.
 *
 * امنیت داده:
 *  - هر مهاجرت داخل BEGIN…COMMIT اجرا می‌شود ⇒ هرگز اجرای نیمه‌کاره نداریم؛
 *    قطع ناگهانی (کرش/برق/kill) ⇒ SQLite خودش تراکنش نیمه‌کاره را برمی‌گرداند و
 *    اجرای بعدیِ اسکریپت از همان نقطه ادامه می‌دهد (idempotent).
 *  - PRAGMA foreign_keys=OFF فقط «خارج از تراکنش» و فقط برای اجرای DDL مهاجرت
 *    تنظیم می‌شود (داخل تراکنش این pragma نافع است و مهاجرت‌های بازسازی جدولِ
 *    Prisma به آن نیاز دارند). هیچ داده‌ای توسط این اسکریپت نوشته/حذف نمی‌شود.
 *  - این اسکریپت هرگز DROP/DELETE/RESET انجام نمی‌دهد و به داده‌ها دست نمی‌زند.
 *  - دستورهای ممنوعه (migrate reset / db push --accept-data-loss) اینجا وجود ندارند.
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

// جدول‌های کلیدی اسکیمای فعلی — پس از مهاجرت باید همگی موجود باشند (سلامت‌سنجی نهایی)
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

/* ---------------------------------------------------------------------------
 * عکس ساختاری — مبنای مقایسه Baseline ساختاری (بدون اتکا به متن خطا)
 * ------------------------------------------------------------------------- */

/** نرمال‌سازی نوع ستون (TEXT vs text، فاصله‌های اضافی و ...) */
function normType(t) {
  return String(t || "").replace(/\s+/g, " ").trim().toUpperCase();
}

/** نرمال‌سازی مقدار DEFAULT (نقل‌قول، TRUE/FALSE، فاصله) */
function normDefault(d) {
  if (d === null || d === undefined) return null;
  let s = String(d).trim();
  if (s.length >= 2 && ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"')))) {
    s = s.slice(1, -1);
  }
  const up = s.toUpperCase();
  if (up === "TRUE") return "1";
  if (up === "FALSE") return "0";
  return s.replace(/\s+/g, " ");
}

/**
 * عکس کامل ساختار یک دیتابیس — خروجی JSON قطعی (deterministic):
 *  جدول‌ها (بدون _prisma_migrations و sqlite_*) + ستون‌ها + PK + FK + indexها
 *  فیلد order/seq حذف می‌شود چون ترتیب ذخیره‌سازی معنای اسکیمایی ندارد.
 */
function structureSnapshot(dbo) {
  const tables = dbo
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_prisma_migrations' ORDER BY name")
    .all()
    .map((r) => r.name);

  const snap = {};
  for (const t of tables) {
    const columns = dbo
      .prepare(`PRAGMA table_info(${quoteIdent(t)})`)
      .all()
      .map((c) => ({
        name: c.name,
        type: normType(c.type),
        notnull: !!c.notnull,
        dflt: normDefault(c.dflt_value),
        pk: c.pk > 0,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // FKها — گروه‌بندی بر اساس id (هر قید FK ممکن است چند ستون داشته باشد)
    const fkRows = dbo.prepare(`PRAGMA foreign_key_list(${quoteIdent(t)})`).all();
    const fkGroups = new Map();
    for (const r of fkRows) {
      if (!fkGroups.has(r.id)) fkGroups.set(r.id, []);
      fkGroups.get(r.id).push(r);
    }
    const foreignKeys = [...fkGroups.values()]
      .map((rows) => ({
        table: rows[0].table,
        from: rows.map((r) => r.from).sort(),
        to: rows.map((r) => r.to).sort(),
        onDelete: rows[0].on_delete,
        onUpdate: rows[0].on_update,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    // indexها — فقط origin «c» (CREATE INDEX) و «u» (قید UNIQUE)؛
    // origin «pk» autoindex خودکار PK است و در table_info از قبل آمده
    const idxRows = dbo
      .prepare(`PRAGMA index_list(${quoteIdent(t)})`)
      .all()
      .filter((r) => r.origin === "c" || r.origin === "u");
    const indexes = idxRows
      .map((r) => ({
        name: r.name,
        unique: !!r.unique,
        columns: dbo
          .prepare(`PRAGMA index_info(${quoteIdent(r.name)})`)
          .all()
          .map((c) => c.name)
          .sort(),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    snap[t] = { columns, foreignKeys, indexes };
  }
  return JSON.stringify(snap);
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** فهرست مهاجرت‌ها به ترتیب نام (پیشوند زمانی YYYYMMDDHHMMSS) */
function listMigrations(migrationsDir) {
  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{14}_/.test(d.name))
    .map((d) => d.name)
    .sort();
}

/** خواندن SQL و checksum هر مهاجرت */
function loadMigration(migrationsDir, name) {
  const sqlPath = path.join(migrationsDir, name, "migration.sql");
  if (!fs.existsSync(sqlPath)) {
    throw new Error("فایل migration.sql برای «" + name + "» پیدا نشد");
  }
  const sql = fs.readFileSync(sqlPath, "utf8");
  const checksum = crypto.createHash("sha256").update(sql).digest("hex");
  return { sql, checksum };
}

/** ثبت ردیف مهاجرت در _prisma_migrations (سازگار با Prisma) */
function recordMigration(dbo, name, checksum, logs) {
  dbo
    .prepare(
      `INSERT INTO "_prisma_migrations"
         ("id","checksum","finished_at","migration_name","logs","rolled_back_at","started_at","applied_steps_count")
       VALUES (?,?,?,?,?,NULL,?,1)`
    )
    .run(
      crypto.randomUUID(),
      checksum,
      new Date().toISOString().replace("T", " ").replace("Z", ""),
      name,
      logs || "",
      new Date().toISOString().replace("T", " ").replace("Z", "")
    );
}

/**
 * اجرای همه مهاجرت‌های در انتظار + Baseline ساختاری.
 * خطا ⇒ throw (سرور متوقف می‌شود) و هیچ داده‌ای تغییر نکرده است.
 * @param {{dbFile?: string, migrationsDir?: string}} opts
 */
function runMigrations(opts = {}) {
  const dbFile = opts.dbFile || resolveDbFile();
  const migrationsDir = opts.migrationsDir || path.join(__dirname, "..", "prisma", "migrations");
  const dbDir = path.dirname(dbFile);
  fs.mkdirSync(dbDir, { recursive: true });

  // node:sqlite — داخلی Node.js 24 (بدون هیچ وابستگی خارجی)
  const { DatabaseSync } = require("node:sqlite");
  const dbo = new DatabaseSync(dbFile, { enableForeignKeyConstraints: false });
  try {
    dbo.exec("PRAGMA journal_mode = WAL;");
    dbo.exec("PRAGMA busy_timeout = 10000;");
    dbo.exec(PRISMA_MIGRATIONS_TABLE_SQL);

    const migrations = listMigrations(migrationsDir);
    if (migrations.length === 0) warn("هیچ پوشه مهاجرتی پیدا نشد: " + migrationsDir);

    const recorded = new Set(
      dbo
        .prepare("SELECT migration_name FROM _prisma_migrations WHERE rolled_back_at IS NULL")
        .all()
        .map((r) => r.migration_name)
    );

    // ── ۱) ساخت «وضعیت‌های میانی مورد انتظار» با بازپخش مهاجرت‌ها در حافظه ──
    //      states[k] = ساختار پس از k مهاجرت اول (states[0] = دیتابیس خالی)
    const mem = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
    const states = [];
    states.push(structureSnapshot(mem));
    for (const name of migrations) {
      const { sql } = loadMigration(migrationsDir, name);
      mem.exec(sql);
      states.push(structureSnapshot(mem));
    }
    mem.close();

    // ── ۲) ساختار واقعی دیتابیس باید با «یکی» از وضعیت‌های میانی تطبیق کند ──
    const live = structureSnapshot(dbo);
    let k = -1;
    for (let i = 0; i < states.length; i++) {
      if (states[i] === live) {
        k = i;
        break;
      }
    }
    if (k === -1) {
      // دیتابیس ناقص/ناسازگار/غریبه — توقف کامل، بدون هیچ تغییری
      const diffHint = describeDiff(live, states);
      throw new Error(
        "ساختار دیتابیس با هیچ مرحله‌ای از مهاجرت‌ها همخوان نیست — متوقف شد و هیچ داده‌ای تغییر نکرد." +
          (diffHint ? "\n" + diffHint : "") +
          "\nاز نسخه پشتیبان معتبر استفاده کنید یا ساختار را با اسکیمای برنامه بازسازی کنید (بدون db push --accept-data-loss)."
      );
    }

    let applied = 0;
    let baselined = 0;

    // ── ۳) مهاجرت‌های «قبل از k»: ساختار از قبل هست ⇒ فقط رکورد (baseline) ──
    for (let i = 0; i < k; i++) {
      const name = migrations[i];
      if (recorded.has(name)) continue;
      const { checksum } = loadMigration(migrationsDir, name);
      recordMigration(dbo, name, checksum, "baselined: structure already matched target state (structural check)");
      baselined++;
      warn("baseline ساختاری: «" + name + "» در ساختار موجود بود — فقط ثبت شد (هیچ SQL اجرا نشد)");
    }

    // ── ۴) مهاجرت‌های «از k به بعد»: رکورد داشتن ولی نبودن در ساختار = ناسازگاری ──
    for (let i = k; i < migrations.length; i++) {
      const name = migrations[i];
      if (recorded.has(name)) {
        throw new Error(
          "ناسازگاری جدول مهاجرت با ساختار واقعی: رکورد «" + name +
            "» موجود است ولی ساختار دیتابیس آن را ندارد — متوقف شد؛ از نسخه پشتیبان استفاده کنید"
        );
      }
    }

    // ── ۵) اجرای مهاجرت‌های باقی‌مانده — هر کدام در تراکنش خودش + تأیید ساختاری ──
    for (let i = k; i < migrations.length; i++) {
      const name = migrations[i];
      const { sql, checksum } = loadMigration(migrationsDir, name);
      const started = new Date().toISOString().replace("T", " ").replace("Z", "");

      // PRAGMA foreign_keys باید «خارج از تراکنش» تنظیم شود (داخل تراکنش نافع است)
      dbo.exec("PRAGMA foreign_keys = OFF;");
      dbo.exec("BEGIN");
      try {
        dbo.exec(sql);
        const after = structureSnapshot(dbo);
        if (after !== states[i + 1]) {
          // ساختار پس از اجرا با وضعیت مورد انتظار نمی‌خواند ⇒ رد و توقف
          try {
            dbo.exec("ROLLBACK");
          } catch {}
          throw new Error(
            "اجرای مهاجرت «" + name + "» ساختار مورد انتظار نسخه بعد را نساخت — ROLLBACK شد و هیچ تغییری ماندگار نشد"
          );
        }
        dbo.exec("COMMIT");
        applied++;
        log("مهاجرت اعمال شد: " + name);
        recordMigration(dbo, name, checksum, "");
        void started;
      } catch (e) {
        // تضمین: در هر خطا تراکنش برمی‌گردد (اگر خودمان ROLLBACK نکرده باشیم)
        try {
          dbo.exec("ROLLBACK");
        } catch {}
        throw e;
      }
    }

    // ── ۶) سلامت‌سنجی نهایی — جدول‌های کلیدی اسکیما باید موجود باشند ──
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
        (baselined ? " (baseline ساختاری ثبت‌شده: " + baselined + ")" : "") +
        (applied === 0 && baselined === 0 ? " (بدون تغییر — همه قبلاً اعمال شده)" : "")
    );
  } finally {
    dbo.close();
  }
}

/** راهنمای متنی تفاوت ساختار — فقط برای پیام خطا (اولین مغایرت) */
function describeDiff(liveStr, states) {
  try {
    const live = JSON.parse(liveStr);
    const last = JSON.parse(states[states.length - 1]);
    const names = new Set([...Object.keys(live), ...Object.keys(last)]);
    const onlyLive = [...names].filter((t) => live[t] && !last[t]);
    const onlyTarget = [...names].filter((t) => last[t] && !live[t]);
    const different = [...names].filter((t) => live[t] && last[t] && JSON.stringify(live[t]) !== JSON.stringify(last[t]));
    const parts = [];
    if (onlyLive.length) parts.push("جدول اضافه در دیتابیس: " + onlyLive.join(", "));
    if (onlyTarget.length) parts.push("جدول غایب در دیتابیس: " + onlyTarget.join(", "));
    if (different.length) parts.push("ساختار متفاوت: " + different.join(", "));
    return parts.length ? "تفاوت‌ها: " + parts.join(" | ") : "";
  } catch {
    return "";
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
