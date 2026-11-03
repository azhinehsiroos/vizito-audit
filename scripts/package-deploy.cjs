#!/usr/bin/env node
"use strict";

/**
 * ---------------------------------------------------------------------------
 * scripts/package-deploy.cjs — ساخت بسته آماده‌ی «اجرا بدون Build» برای cPanel
 * ---------------------------------------------------------------------------
 * ورودی:  خروجی کامل `npm run build` (پوشه <distDir>/standalone بسته‌بندی‌شده)
 * خروجی:  download/vizito-prod-<نسخه>.zip — کافی است روی هاست استخراج شود:
 *
 *   vizito-prod/
 *   ├── .next/standalone/…      (server.js + node_modules ردیابی‌شده + static + public)
 *   │                            شامل موتورهای Prisma (برای پلتفرم‌های هاست) و sharp لینوکسی
 *   ├── server.cjs              (Startup File در cPanel)
 *   ├── scripts/migrate-sqlite.cjs  (مهاجرت بدون Prisma CLI — node:sqlite داخلی Node 24)
 *   ├── prisma/schema.prisma + migrations/
 *   ├── package.json / .env.example
 *   └── docs/DEPLOY-CPANEL-FA.md
 *
 * ⚠️ این بسته «هرگز» شامل .env، کلیدها (keys/)، دیتابیس (db/) یا هر فایل حساس نیست.
 * روی هاست هیچ npm install / next build / prisma generate لازم نیست — فقط:
 *   تنظیم متغیرهای محیطی در cPanel + node server.cjs
 * ---------------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DIST_DIR = process.env.NEXT_DIST_DIR || ".next";
const STANDALONE_DIR = path.join(ROOT, DIST_DIR, "standalone");

function die(msg) {
  console.error("[vizito-deploy] ✖ " + msg);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = pkg.version;
const OUT_DIR = path.join(ROOT, "download");
const STAGE = path.join(OUT_DIR, `vizito-prod-${version}`);
const OUT_ZIP = path.join(OUT_DIR, `vizito-prod-${version}.zip`);

if (!fs.existsSync(path.join(STANDALONE_DIR, "server.js"))) {
  die(
    "خروجی Standalone نیست — ابتدا بیلد کامل بگیرید:\n" +
      "  npm ci && npm run build"
  );
}

// پاک‌سازی مرحله قبلی
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

function copy(from, to, { must = true } = {}) {
  const src = path.join(ROOT, from);
  if (!fs.existsSync(src)) {
    if (must) die("منبع پیدا نشد: " + from);
    return;
  }
  fs.cpSync(src, path.join(STAGE, to), { recursive: true, force: true });
}

console.log("[vizito-deploy] ۱/۶ کپی Standalone (شامل static + public و موتورها) ...");
fs.cpSync(STANDALONE_DIR, path.join(STAGE, ".next", "standalone"), { recursive: true, force: true });

console.log("[vizito-deploy] ۲/۶ فایل‌های راه‌اندازی و مهاجرت ...");
copy("server.cjs", "server.cjs");
copy("scripts/migrate-sqlite.cjs", "scripts/migrate-sqlite.cjs");
copy("prisma/schema.prisma", "prisma/schema.prisma");
copy("prisma/migrations", "prisma/migrations");

console.log("[vizito-deploy] ۳/۶ مستندات و مرجع نسخه ...");
copy("package.json", "package.json");
copy(".env.example", ".env.example");
copy("docs/DEPLOY-CPANEL-FA.md", "docs/DEPLOY-CPANEL-FA.md", { must: false });

console.log("[vizito-deploy] ۴/۶ بهداشت امنیتی — حذف .env و فایل‌های حساس از بسته ...");
// هرگز: env، کلیدها، دیتابیس، لاگ، پوشه توسعه
const forbidden = [".env", ".env.local", ".env.production", ".env.production.local"];
for (const f of forbidden) {
  const p = path.join(STAGE, ".next", "standalone", f);
  if (fs.existsSync(p)) fs.rmSync(p, { force: true });
}
const sensitive = ["db", "keys", "keystore", "download", "node_modules", ".git"];
for (const d of sensitive) {
  const p = path.join(STAGE, d);
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
// حذف باینری‌های musl — cPanel/Passenger همیشه گنو/گلیبک است (RHEL-فمیلی) و musl هرگز لود نمی‌شود
const muslDirs = [
  path.join(STAGE, ".next", "standalone", "node_modules", "@img", "sharp-linuxmusl-x64"),
  path.join(STAGE, ".next", "standalone", "node_modules", "@img", "sharp-libvips-linuxmusl-x64"),
];
for (const d of muslDirs) {
  if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
}
console.log("[vizito-deploy] ✔ واریانت‌های musl sharp حذف شد (هاست cPanel گلیبک است)");

console.log("[vizito-deploy] ۵/۶ صحت‌سنجی نهایی بسته (فایل‌های ضروری + باینری‌های لینوکسی) ...");
// ── فایل‌های ضروری بسته — نبودِ هرکدام ⇒ توقف با خطای واضح (ممیزی v1.0.9) ──
const requiredPaths = [
  [".next/standalone/server.js", "file", "سرور Standalone"],
  [".next/standalone/.next/static", "dir", "فایل‌های استاتیک build"],
  ["server.cjs", "file", "Startup File پنل cPanel"],
  ["scripts/migrate-sqlite.cjs", "file", "مهاجرت بدون Prisma CLI"],
  ["prisma/schema.prisma", "file", "اسکیمای Prisma"],
  ["prisma/migrations", "dir", "مهاجرت‌های دیتابیس"],
  ["package.json", "file", "مرجع نسخه"],
  [".env.example", "file", "نمونه متغیرهای محیطی"],
];
for (const [rel, kind, label] of requiredPaths) {
  const p = path.join(STAGE, ...rel.split("/"));
  if (!fs.existsSync(p)) die("فایل ضروری بسته پیدا نشد: " + rel + " (" + label + ")");
  if (kind === "dir" && !fs.statSync(p).isDirectory()) die("مسیر ضروری پوشه نیست: " + rel);
}
const migDirs = fs
  .readdirSync(path.join(STAGE, "prisma", "migrations"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{14}_/.test(d.name));
if (migDirs.length === 0) die("هیچ پوشه مهاجرتی (NNNNNNNNNNNNNN_*) در prisma/migrations نیست");

// ── باینری‌های پلتفرم هدف (Linux x64 / glibc) در خود بسته ──
const stageNm = path.join(STAGE, ".next", "standalone", "node_modules");
const stagePrisma = path.join(stageNm, ".prisma", "client");
const stageEngines = fs.existsSync(stagePrisma)
  ? fs.readdirSync(stagePrisma).filter((f) => /^libquery_engine-.*\.so(\.node)?$/.test(f))
  : [];
if (stageEngines.length === 0) {
  die("موتور کوئری لینوکسی Prisma در بسته نیست — بسته روی هاست بالا نمی‌آید (Build را روی لینوکس بگیرید)");
}
for (const d of ["@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64"]) {
  const p = path.join(stageNm, ...d.split("/"));
  const files = fs.existsSync(p) ? fs.readdirSync(p).filter((f) => !f.startsWith(".")) : [];
  if (files.length === 0) die("باینری لینوکسی sharp («" + d + "») در بسته نیست");
}
console.log("[vizito-deploy] ✔ موتورهای Prisma: " + stageEngines.join(", "));
console.log("[vizito-deploy] ✔ باینری‌های sharp لینوکسی x64 موجود است");
console.log("[vizito-deploy] ✔ " + migDirs.length + " مهاجرت دیتابیس همراه بسته است: " + migDirs.map((d) => d.name).join(", "));

console.log("[vizito-deploy] ۶/۶ اسکن محرمانگی بسته قبل از ZIP ...");
// ── اسکن کل بسته: هیچ .env/کلید/دیتابیس/پشتیبانی نباید داخل ZIP باشد ──
const SECRET_PATH_PATTERNS = [
  // .env و هر واریانتش (مثل .env.local/.env.production) ممنوع — فقط .env.example مجاز است
  { re: /(^|\/)\.env(?!\.example)(\.[^/]+)?$/i, why: "فایل env" },
  { re: /\.(pem|jks|keystore|p12|pfx)$/i, why: "کلید/گواهی" },
  { re: /\.(db|sqlite|sqlite3|db-wal|db-shm)$/i, why: "دیتابیس" },
  { re: /(^|\/)(id_rsa|id_dsa|id_ed25519)(\.|$)/i, why: "کلید SSH" },
  { re: /(^|\/)secrets?\.[a-z0-9]+$/i, why: "فایل secret" },
];
// پوشه‌های حساس فقط در «ریشه بسته» ممنوع‌اند (مسیرهای داخلی Next مثل
// .next/server/app/api/backups بخشی از خود build هستند و مجازند)
for (const d of ["keys", "keystore", "backups", "db", "download"]) {
  if (fs.existsSync(path.join(STAGE, d))) {
    die("پوشه حساس در ریشه بسته پیدا شد: " + d + " — ZIP ساخته نشد");
  }
}
let scanned = 0;
(function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(STAGE, full).split(path.sep).join("/");
    if (ent.isDirectory()) {
      walk(full);
      continue;
    }
    scanned++;
    for (const { re, why } of SECRET_PATH_PATTERNS) {
      if (re.test(rel)) {
        die("محتوای ممنوعه در بسته پیدا شد [" + why + "]: " + rel + " — ZIP ساخته نشد");
      }
    }
  }
})(STAGE);
console.log("[vizito-deploy] ✔ اسکن " + scanned + " فایل — بدون .env/کلید/دیتابیس/پشتیبان");

console.log("[vizito-deploy] فشرده‌سازی ZIP ...");
fs.rmSync(OUT_ZIP, { force: true });
execSync(`cd "${OUT_DIR}" && zip -qr "${path.basename(OUT_ZIP)}" "${path.basename(STAGE)}"`, {
  stdio: "inherit",
});

const sizeMB = (fs.statSync(OUT_ZIP).size / 1024 / 1024).toFixed(1);
console.log("[vizito-deploy] ✔ بسته آماده است: download/" + path.basename(OUT_ZIP) + " (" + sizeMB + " MB)");
console.log("[vizito-deploy] مراحل بعدی: docs/DEPLOY-CPANEL-FA.md");
