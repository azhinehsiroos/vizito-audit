#!/usr/bin/env node
"use strict";

/**
 * ---------------------------------------------------------------------------
 * server.cjs — فایل راه‌اندازی Production ویزیتو (cPanel / Node.js 24+)
 * ---------------------------------------------------------------------------
 * این فایل نقطه ورود برنامه روی هاست است:
 *   - در cPanel (Setup Node.js App) مقدار «Application startup file» را روی
 *     همین فایل بگذارید:  server.cjs
 *   - یا از خط فرمان:      node server.cjs   (معادل npm start)
 *
 * کاری که انجام می‌دهد (به ترتیب):
 *  ۱) NODE_ENV=production
 *  ۲) خواندن فایل .env کنار خودش (بدون بازنویسی متغیرهای تنظیم‌شده در پنل)
 *  ۳) بررسی‌های پیش از راه‌اندازی (preflight):
 *     - وجود DATABASE_URL و مطلق بودن مسیر فایل SQLite (بیرون از public_html)
 *     - ساخت و تست قابل‌نوشتن‌بودن پوشه دیتابیس و VIZITO_DATA_DIR
 *     - هشدار واضح برای متغیرهای امنیتی تنظیم‌نشده
 *     - وجود خروجی Standalone (.next/standalone/server.js)
 *  ۴) اجرای «prisma migrate deploy» با قفل فایلی (ضد اجرای هم‌زمان چند پروسه)
 *     - شکست مهاجرت ⇒ سرور بالا نمی‌آید و کد خطا مخفی نمی‌شود
 *  ۵) اجرای سرور Next.js Standalone با node (بدون Bun، بدون tee)
 *     - سیگنال‌های SIGTERM/SIGINT به پروسه سرور منتقل می‌شوند
 *
 * هیچ secret مقداری در لاگ نوشته نمی‌شود.
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = __dirname;
// distDir قابل تنظیم برای Build‌های آزمایشی (NEXT_DIST_DIR) — پیش‌فرض .next (رفتار عادی cPanel)
const DIST_DIR = process.env.NEXT_DIST_DIR || ".next";
const STANDALONE_SERVER = path.join(ROOT, DIST_DIR, "standalone", "server.js");
const MIGRATE_LOCK = path.join(ROOT, ".vizito-migrate.lock");
const LOCK_STALE_MS = 10 * 60 * 1000; // قفل قدیمی‌تر از این ⇒ تاریخ‌گذشته
const LOCK_WAIT_MS = 5 * 60 * 1000; // حداکثر انتظار برای آزاد شدن قفل

function die(msg) {
  console.error("\n[vizito] ✖ " + msg + "\n");
  process.exit(1);
}
function warn(msg) {
  console.warn("[vizito] ⚠ " + msg);
}
function log(msg) {
  console.log("[vizito] " + msg);
}

/* --------------------------- ۱) NODE_ENV --------------------------- */
process.env.NODE_ENV = "production";

/* ------------------- ۱.۵) گارد نسخه Node.js (الزامی: ۲۴+) -------------------
 * وابستگی html2canvas-pro@2.5.2 (خروجی PDF گزارش‌ها) رسماً node >= 24 می‌خواهد؛
 * روی نسخه پایین‌تر با پیام واضح متوقف می‌شویم تا برنامه روی runtime تست‌نشده بالا نیاید.
 */
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < 24) {
  die(
    "Node.js " +
      process.versions.node +
      " پشتیبانی نمی‌شود (حداقل نسخه: 24).\n" +
      "    وابستگی html2canvas-pro@2.5.2 به Node.js >= 24 نیاز دارد.\n" +
      "    در cPanel → Setup Node.js App نسخه Node.js را روی 24 بگذارید و دکمه Restart را بزنید."
  );
}

/* ------------------- ۲) خواندن .env (بدون بازنویسی) ------------------- */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  try {
    const text = fs.readFileSync(file, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    log("فایل .env خوانده شد (متغیرهای تنظیم‌شده در پنل اولویت دارند)");
  } catch (e) {
    warn("خواندن .env ناموفق بود: " + e.message);
  }
}
loadDotEnv(path.join(ROOT, ".env"));

/* ------------------- ۳) بررسی‌های پیش از راه‌اندازی ------------------- */

// دیتابیس
const dbUrl = (process.env.DATABASE_URL || "").trim();
if (!dbUrl) {
  die(
    "DATABASE_URL تنظیم نشده است.\n" +
      "    در cPanel → Setup Node.js App → Environment variables اضافه کنید:\n" +
      "    DATABASE_URL = file:/home/USERNAME/vizito_data/vizito.db"
  );
}
if (!dbUrl.startsWith("file:")) {
  die("DATABASE_URL باید با file: شروع شود (SQLite) — مقدار فعلی پشتیبانی نمی‌شود");
}
const dbFilePath = dbUrl.slice("file:".length).split("?")[0];
if (!path.isAbsolute(dbFilePath)) {
  die(
    "مسیر دیتابیس باید «مطلق» باشد (مسیر نسبی به پوشه اجرای سرور وابسته می‌شود و روی cPanel ناپایدار است).\n" +
      "    مثال صحیح: file:/home/USERNAME/vizito_data/vizito.db"
  );
}
const dbDir = path.dirname(dbFilePath);
function assertWritable(dir, label) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".vizito-write-test-" + Date.now());
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
  } catch (e) {
    die("پوشه " + label + " قابل نوشتن نیست (" + dir + "): " + e.message);
  }
}
assertWritable(dbDir, "دیتابیس");
log("پوشه دیتابیس آماده است: " + dbDir);

// پوشه داده‌های ماندگار (پشتیبان‌ها)
const dataDir = (process.env.VIZITO_DATA_DIR || "").trim();
if (dataDir) {
  assertWritable(dataDir, "داده‌های ماندگار (VIZITO_DATA_DIR)");
  log("پوشه داده‌های ماندگار آماده است: " + dataDir);
} else {
  warn(
    "VIZITO_DATA_DIR تنظیم نشده — پشتیبان‌ها در «" +
      path.join(ROOT, "db", "backups") +
      "» ذخیره می‌شوند؛ برای پایداری در production این متغیر را به مسیری بیرون از پوشه برنامه تنظیم کنید"
  );
}

// متغیرهای امنیتی — فقط هشدار (برنامه بدون آن‌ها هم بالا می‌آید ولی قابلیت‌ها محدود می‌شوند)
const bk = process.env.BACKUP_ENCRYPTION_KEY || "";
if (bk.length < 32) {
  warn(
    "BACKUP_ENCRYPTION_KEY تنظیم نشده یا کوتاه‌تر از ۳۲ کاراکتر است — پشتیبان‌گیری (دستی و خودکار) خطا می‌دهد"
  );
}
if (!process.env.SETUP_TOKEN) {
  warn(
    "SETUP_TOKEN تنظیم نشده — روی نصب تازه، ثبت‌نام اولین مدیر (با کد راه‌اندازی) ممکن نخواهد بود"
  );
}
if (!process.env.OWNER_MOBILES) {
  warn("OWNER_MOBILES تنظیم نشده — حساب سازنده (دسترسی همیشگی) فعال نیست");
}
if (process.env.OWNER_MOBILES && !process.env.OWNER_SETUP_KEY) {
  warn(
    "OWNER_SETUP_KEY تنظیم نشده — ثبت‌نام با شماره‌های سازنده همیشه خطای OWNER_KEY_REQUIRED می‌دهد." +
      "\n    در cPanel → Setup Node.js App → Environment variables مقدار OWNER_SETUP_KEY را اضافه کنید"
  );
}

// خروجی Standalone
if (!fs.existsSync(STANDALONE_SERVER)) {
  die(
    "خروجی Standalone پیدا نشد: .next/standalone/server.js\n" +
      "    ابتدا دستور زیر را اجرا کنید:  npm run build"
  );
}

/* ------------------- ۴) مهاجرت دیتابیس با قفل -------------------
 * اجرای مهاجرت‌ها با موتور داخلی Node.js (node:sqlite) و «صفر وابستگی»:
 *  - به Prisma CLI، موتور schema یا شبکه نیازی نیست (روی cPanel مطمئن است)
 *  - سازگار با جدول _prisma_migrations خود Prisma
 *  - دیتابیس‌های ساخته‌شده با db push به‌صورت امن baseline می‌شوند (بدون دست‌زدن به داده‌ها)
 *  - هر مهاجرت داخل BEGIN…COMMIT است — اجرای نیمه‌کاره ممکن نیست
 */

function sleepSync(ms) {
  // انتظار همگام بدون بسته‌بودن event loop برای سیگنال‌ها
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    spawnSync("sleep", [String(ms / 1000)]);
  }
}

function acquireMigrateLock() {
  const t0 = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(MIGRATE_LOCK, "wx"); // اتمیک — اگر وجود داشته باشد خطا می‌دهد
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== "EEXIST") {
        die("ساخت قفل مهاجرت ناموفق بود: " + e.message);
      }
      let ageMs = 0;
      try {
        const info = JSON.parse(fs.readFileSync(MIGRATE_LOCK, "utf8"));
        ageMs = Date.now() - new Date(info.at).getTime();
      } catch {
        try {
          ageMs = Date.now() - fs.statSync(MIGRATE_LOCK).mtimeMs;
        } catch {
          try {
            fs.unlinkSync(MIGRATE_LOCK);
          } catch {}
          continue;
        }
      }
      if (ageMs > LOCK_STALE_MS) {
        warn("قفل مهاجرت تاریخ‌گذشته (>" + LOCK_STALE_MS / 60000 + " دقیقه) حذف شد");
        try {
          fs.unlinkSync(MIGRATE_LOCK);
        } catch {}
        continue;
      }
      if (Date.now() - t0 > LOCK_WAIT_MS) {
        die(
          "اجرای مهاجرت دیگری در جریان است (قفل: " +
            MIGRATE_LOCK +
            ") — پس از آزاد شدن قفل دوباره تلاش کنید"
        );
      }
      sleepSync(1000);
    }
  }
}

const MIGRATOR = path.join(ROOT, "scripts", "migrate-sqlite.cjs");
if (!fs.existsSync(MIGRATOR)) {
  die(
    "اسکریپت مهاجرت پیدا نشد: scripts/migrate-sqlite.cjs\n" +
      "    فایل‌های Deploy ناقص است — کل محتوای ZIP منتشرشده را استخراج کنید"
  );
}

let migrateStatus = 0;
try {
  acquireMigrateLock();
  log("اجرای مهاجرت‌های دیتابیس (موتور داخلی node:sqlite، بدون Prisma CLI) ...");
  try {
    const { runMigrations } = require(MIGRATOR);
    runMigrations();
  } catch (e) {
    console.error("[vizito-db] ✖ " + ((e && e.message) || e));
    migrateStatus = 1;
  }
} finally {
  try {
    fs.unlinkSync(MIGRATE_LOCK);
  } catch {}
}
if (migrateStatus !== 0) {
  die(
    "اجرای مهاجرت‌های دیتابیس ناموفق بود — سرور عمداً راه‌اندازی نمی‌شود تا با ساختار ناسازگار بالا نیاید.\n" +
      "    جزئیات خطا در لاگ بالاست؛ داده‌ها دست‌نخورده‌اند. در صورت ابهام از پشتیبان استفاده نکنید — ابتدا علت را بررسی کنید."
  );
}
log("مهاجرت‌های دیتابیس به‌روز است ✔");

/* ------------------- ۵) شروع سرور Next.js Standalone ------------------- */

log("شروع سرور Next.js (standalone) با Node.js " + process.version + " ...");

const child = spawn(
  process.execPath,
  [STANDALONE_SERVER],
  {
    stdio: "inherit",
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: process.env.PORT || "3000",
      HOSTNAME: process.env.HOSTNAME || "0.0.0.0",
    },
  }
);

function forwardSignal(sig) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {}
  });
}
forwardSignal("SIGTERM");
forwardSignal("SIGINT");

child.on("exit", (code, signal) => {
  if (signal) {
    log("سرور با سیگنال " + signal + " متوقف شد");
    process.exit(0);
  }
  process.exit(code === null ? 0 : code);
});

child.on("error", (e) => {
  die("اجرای سرور Next.js ناموفق بود: " + e.message);
});
