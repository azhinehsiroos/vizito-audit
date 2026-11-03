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

console.log("[vizito-deploy] ۱/۵ کپی Standalone (شامل static + public و موتورها) ...");
fs.cpSync(STANDALONE_DIR, path.join(STAGE, ".next", "standalone"), { recursive: true, force: true });

console.log("[vizito-deploy] ۲/۵ فایل‌های راه‌اندازی و مهاجرت ...");
copy("server.cjs", "server.cjs");
copy("scripts/migrate-sqlite.cjs", "scripts/migrate-sqlite.cjs");
copy("prisma/schema.prisma", "prisma/schema.prisma");
copy("prisma/migrations", "prisma/migrations");

console.log("[vizito-deploy] ۳/۵ مستندات و مرجع نسخه ...");
copy("package.json", "package.json");
copy(".env.example", ".env.example");
copy("docs/DEPLOY-CPANEL-FA.md", "docs/DEPLOY-CPANEL-FA.md", { must: false });

console.log("[vizito-deploy] ۴/۵ بهداشت امنیتی — حذف .env و فایل‌های حساس از بسته ...");
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

console.log("[vizito-deploy] ۵/۵ فشرده‌سازی ZIP ...");
fs.rmSync(OUT_ZIP, { force: true });
execSync(`cd "${OUT_DIR}" && zip -qr "${path.basename(OUT_ZIP)}" "${path.basename(STAGE)}"`, {
  stdio: "inherit",
});

const sizeMB = (fs.statSync(OUT_ZIP).size / 1024 / 1024).toFixed(1);
console.log("[vizito-deploy] ✔ بسته آماده است: download/" + path.basename(OUT_ZIP) + " (" + sizeMB + " MB)");
console.log("[vizito-deploy] مراحل بعدی: docs/DEPLOY-CPANEL-FA.md");
