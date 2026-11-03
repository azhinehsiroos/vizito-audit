#!/usr/bin/env node
"use strict";

/**
 * scripts/package-standalone.cjs — تکمیل خروجی Next.js Standalone
 * -----------------------------------------------------------------
 * `next build` با output: "standalone" فقط server.js و node_modules را
 * می‌سازد؛ فایل‌های استاتیک و public باید «دستی» داخل خروجی کپی شوند.
 * این اسکریپت (به‌جای زنجیره cp در لینوکس) همین کار را مستقل از سیستم‌عامل
 * و با پیام خطای واضح انجام می‌دهد:
 *   ۱) .next/static  →  .next/standalone/.next/static
 *   ۲) public/*      →  .next/standalone/public  (اگر public وجود داشته باشد)
 *
 * اجرا: به‌صورت خودکار انتهای «npm run build» انجام می‌شود.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
// distDir قابل تنظیم برای Build‌های آزمایشی (NEXT_DIST_DIR) — پیش‌فرض .next
const DIST_DIR = process.env.NEXT_DIST_DIR || ".next";
const STANDALONE_DIR = path.join(ROOT, DIST_DIR, "standalone");
const SERVER_JS = path.join(STANDALONE_DIR, "server.js");

function die(msg) {
  console.error("[vizito] ✖ " + msg);
  process.exit(1);
}

function copyDir(src, dest) {
  try {
    fs.cpSync(src, dest, { recursive: true, force: true });
  } catch (e) {
    die("کپی «" + src + "» به «" + dest + "» ناموفق بود: " + e.message);
  }
}

if (!fs.existsSync(SERVER_JS)) {
  die(
    path.join(DIST_DIR, "standalone/server.js") + " پیدا نشد — خروجی Standalone ساخته نشده است.\n" +
      "  مطمئن شوید در next.config.ts مقدار output: \"standalone\" است و next build بدون خطا تمام شده."
  );
}

// ۱) فایل‌های استاتیک (JS/CSS های build)
const staticSrc = path.join(ROOT, DIST_DIR, "static");
const staticDest = path.join(STANDALONE_DIR, ".next", "static");
if (!fs.existsSync(staticSrc)) {
  die(".next/static پیدا نشد — خروجی build ناقص است");
}
copyDir(staticSrc, staticDest);
console.log("[vizito] ✔ فایل‌های استاتیک کپی شد → " + path.join(DIST_DIR, "standalone/.next/static"));

// ۲) public (لوگوها، robots.txt و ...)
const publicSrc = path.join(ROOT, "public");
const publicDest = path.join(STANDALONE_DIR, "public");
if (fs.existsSync(publicSrc)) {
  copyDir(publicSrc, publicDest);
  console.log("[vizito] ✔ پوشه public کپی شد → .next/standalone/public");
} else {
  console.warn("[vizito] ⚠ پوشه public وجود ندارد — از کپی صرف‌نظر شد");
}

// ۳) بهداشت امنیتی — Next فایل‌های .env را داخل Standalone هم کپی می‌کند؛
//    نسخه تکراری حذف می‌شود تا secretها فقط از env پنل/فایل .env ریشه خوانده شوند
//    (server.cjs متغیرهای محیطی را قبل از اجرای سرور لود می‌کند)
const envFiles = [".env", ".env.production", ".env.local", ".env.production.local"];
let removedEnv = 0;
for (const f of envFiles) {
  const p = path.join(STANDALONE_DIR, f);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { force: true });
    removedEnv++;
  }
}
if (removedEnv > 0) {
  console.log("[vizito] ✔ " + removedEnv + " فایل .env تکراری از خروجی Standalone حذف شد (بهداشت امنیتی)");
}

// ۴) صحت‌سنجی عمیق باینری‌های پلتفرم هدف (Linux x64 / glibc) — ممیزی v1.0.9 + v1.0.10
//    دیگر «وجود پوشه» کافی نیست: ساختار ELF (کلاس/معماری) و حداکثر نسخه GLIBC
//    موردنیاز هر باینری Prisma/sharp پارس و با سقف هاست (۲٫۲۸) مقایسه می‌شود —
//    پارس مستقیم بایت‌ها، مستقل از سیستم‌عاملِ Build (ویندوز هم پشتیبانی می‌شود)
const nm = path.join(STANDALONE_DIR, "node_modules");
const { validateLinuxBinaries, limitationsLine } = require("./validate-linux-binaries.cjs");
console.log(limitationsLine("[vizito]"));
try {
  const report = validateLinuxBinaries(nm, "[vizito]");
  report.forEach((l) => console.log(l));
} catch (e) {
  die(e && e.message);
}

// ۵) صحت‌سنجی نهایی
if (!fs.existsSync(staticDest)) die("پس از بسته‌بندی، مسیر static در Standalone نیست");
if (fs.existsSync(path.join(STANDALONE_DIR, ".env"))) die("حذف .env از Standalone ناموفق بود");
console.log("[vizito] ✔ خروجی Standalone کامل شد: .next/standalone");
