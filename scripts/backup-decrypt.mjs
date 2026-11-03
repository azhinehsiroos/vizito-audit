#!/usr/bin/env node
/**
 * رمزگشایی فایل نسخه پشتیبان ویزیتو (نسخه Node.js) — برای سازنده/مدیر سرور
 * -------------------------------------------------------------------------
 * قالب: پاکت VIZITO-ENC-2 با AES-256-GCM (دقیقاً همان منطق src/lib/backup.ts
 * بدون وابستگی به Bun یا دیتابیس).
 *
 * استفاده (Node 22+):
 *   npm run backup:decrypt -- <فایل پشتیبان>.json -o restored.json
 *   BACKUP_ENCRYPTION_KEY=... npm run backup:decrypt -- file.json -o restored.json
 *
 * کلید از env: BACKUP_ENCRYPTION_KEY ساخته می‌شود؛ شناسه نصب (نمک) داخل خود
 * فایل ذخیره شده است. فرمت قدیمیِ بدون رمزنگاری هم پذیرفته می‌شود.
 */

import fs from "node:fs";
import crypto from "node:crypto";

const FMT = "VIZITO-ENC-2";

function arg(name) {
  // هم -x و هم --x را می‌پذیرد (مثلاً -o و --out)
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === `--${name}` || a === `-${name}`) {
      const v = process.argv[i + 1];
      return v && !v.startsWith("-") ? v : undefined;
    }
  }
  return undefined;
}

function backupKey(installId) {
  const secret = process.env.BACKUP_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error("BACKUP_ENCRYPTION_KEY الزامی است (حداقل ۳۲ کاراکتر) — همان کلید سرور را در env بگذارید");
  }
  return crypto.scryptSync(secret, `vizito-backup::${installId}`, 32);
}

function decryptEnvelope(text) {
  const parsed = JSON.parse(text);
  if (
    parsed.fmt !== FMT ||
    !parsed.iv ||
    !parsed.tag ||
    !parsed.data ||
    !parsed.installId
  ) {
    // فرمت قدیمی (بدون رمزنگاری) — خود فایل JSON خام داده‌هاست
    if (parsed.vizitoBackupVersion || parsed.tables) return text;
    throw new Error("فایل پشتیبان شناخته نشد");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    backupKey(parsed.installId),
    Buffer.from(parsed.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(parsed.data, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}

/** اولین آرگومان پوزیشنی (مسیر فایل پشتیبان) — پرچم‌ها و مقدارهایشان نادیده گرفته می‌شود */
function firstPositional() {
  const isFlagValue = (idx) => {
    const prev = process.argv[idx - 1];
    if (!prev || !prev.startsWith("-")) return false;
    return ["in", "out", "o"].includes(prev.replace(/^-+/, ""));
  };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (!a.startsWith("-") && !isFlagValue(i)) return a;
  }
  return undefined;
}

const input = arg("in") || firstPositional();
const output = arg("out") || arg("o");

if (!input || input.startsWith("--") || !fs.existsSync(input)) {
  console.log("استفاده: npm run backup:decrypt -- <فایل پشتیبان> [-o خروجی.json]");
  process.exit(1);
}

try {
  const text = fs.readFileSync(input, "utf8");
  const json = decryptEnvelope(text);
  if (output) {
    fs.writeFileSync(output, json, "utf8");
    console.log(`رمزگشایی شد ✅ → ${output}`);
  } else {
    console.log(json);
  }
} catch (e) {
  console.error("رمزگشایی نشد:", e.message);
  console.error("اگر روی سرور BACKUP_ENCRYPTION_KEY تنظیم شده، همان را در env بگذارید.");
  process.exit(1);
}
