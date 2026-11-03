/**
 * رمزگشایی فایل نسخه پشتیبان ویزیتو — فقط برای سازنده/مدیر سرور
 *
 * استفاده:
 *   bun run backup:decrypt -- db/backups/vizito-manual-....json -o restored.json
 *   BACKUP_ENCRYPTION_KEY=... bun run backup:decrypt -- file.json -o restored.json
 *
 * کلید از env: BACKUP_ENCRYPTION_KEY (اگر روی سرور تنظیم شده) یا کلید عمومی برنامه ساخته می‌شود؛
 * شناسه نصب داخل خود فایل ذخیره شده است.
 */
import fs from "fs";
import { decryptBackupEnvelope } from "../src/lib/backup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}

const input = arg("in") || process.argv[process.argv.length - 1];
const output = arg("out") || arg("o");

if (!input || input.startsWith("--") || !fs.existsSync(input)) {
  console.log("استفاده: bun run backup:decrypt -- <فایل پشتیبان> [-o خروجی.json]");
  process.exit(1);
}

try {
  const text = fs.readFileSync(input, "utf8");
  const json = decryptBackupEnvelope(text);
  if (output) {
    fs.writeFileSync(output, json, "utf8");
    console.log(`رمزگشایی شد ✅ → ${output}`);
  } else {
    console.log(json);
  }
} catch (e) {
  console.error("رمزگشایی نشد:", (e as Error).message);
  console.error("اگر روی سرور BACKUP_ENCRYPTION_KEY تنظیم شده، همان را در env بگذارید.");
  process.exit(1);
}
