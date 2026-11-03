#!/usr/bin/env node
/**
 * تولیدکننده کلید لایسنس ویزیتو (نسخه Node.js) — فقط برای سازنده برنامه
 * ---------------------------------------------------------------------
 * الگوریتم و قالب دقیقاً همان نسخه داخل برنامه است: VZT2.<payload>.<signature>
 * با امضای Ed25519 (node:crypto — بدون وابستگی به Bun).
 *
 * کلید خصوصی از یکی از این دو مسیر خوانده می‌شود:
 *   ۱) env: LICENSE_PRIVATE_KEY_PEM
 *   ۲) فایل keys/license-private.pem کنار پروژه (خارج از گیت)
 *
 * استفاده (Node 22+):
 *   npm run license:gen -- --name "نام مشتری" --mobile 09121234567 --months 12 --install-id ab12cd34
 *   npm run license:gen -- --name "..." --days 30  --install-id ...
 *   npm run license:gen -- --name "..." --until 2027-01-01 --install-id ...
 *   npm run license:gen -- --name "..." --permanent --install-id ...   (لایسنس دائمی — بدون انقضا، e=0)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function privateKeyPem() {
  const env = process.env.LICENSE_PRIVATE_KEY_PEM;
  if (env && env.includes("PRIVATE KEY")) return env;
  try {
    return fs.readFileSync(path.join(ROOT, "keys", "license-private.pem"), "utf8");
  } catch {
    return null;
  }
}

const name = arg("name");
const mobile = arg("mobile") || "-";
const installId = arg("install-id") || "";
const months = arg("months") ? Number(arg("months")) : undefined;
const days = arg("days") ? Number(arg("days")) : undefined;
const until = arg("until");
// لایسنس دائمی (v1.1.0): پرچم --permanent → payload.e = 0 — بدون تاریخ انقضا،
// خارج از چرخه مهلت ۳۰ روزه/حذف کنترل‌شده؛ شارژ مجدد برای کلید دائمی رد می‌شود.
const permanent = process.argv.includes("--permanent");

let expiresAt = null;
if (permanent) expiresAt = new Date(0); // epoch = e:0 = دائمی در موتور لایسنس
else if (until) expiresAt = new Date(until);
else if (months && months > 0) expiresAt = new Date(Date.now() + months * 30 * 86_400_000);
else if (days && days > 0) expiresAt = new Date(Date.now() + days * 86_400_000);

const usage = () => {
  console.log("استفاده:");
  console.log('  npm run license:gen -- --name "نام مشتری" --mobile 09121234567 --months 12 --install-id ab12cd34');
  console.log("  npm run license:gen -- --name ... --days 30 --install-id ...");
  console.log("  npm run license:gen -- --name ... --until 2027-01-01 --install-id ...");
  console.log("  npm run license:gen -- --name ... --permanent --install-id ...");
};

// امنیت: کلید بدون installId روی هر سروری کار می‌کند — صدورش ممنوع است
if (!installId) {
  console.error("خطا: --install-id الزامی است (شناسه نصب مشتری) — کلید بدون قفل نصب صادر نمی‌شود");
  usage();
  process.exit(1);
}

if (!name || !expiresAt || Number.isNaN(expiresAt.getTime())) {
  usage();
  process.exit(1);
}

const pem = privateKeyPem();
if (!pem) {
  console.error("خطا: کلید خصوصی پیدا نشد");
  console.error("کلید خصوصی باید در keys/license-private.pem باشد (یا env: LICENSE_PRIVATE_KEY_PEM)");
  process.exit(1);
}

try {
  const payload = {
    v: 2,
    n: name.slice(0, 80),
    m: mobile.slice(0, 20),
    e: expiresAt.getTime(),
    i: installId.trim().slice(0, 40),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(crypto.sign(null, Buffer.from(body), crypto.createPrivateKey(pem)));
  const key = `VZT2.${body}.${sig}`;
  console.log("کلید لایسنس برای:", `${name} (${mobile})`);
  console.log(
    expiresAt.getTime() === 0
      ? "انقضا: دائمی (بدون تاریخ انقضا — e=0)"
      : `انقضا: ${expiresAt.toISOString().slice(0, 10)}`
  );
  console.log("قفل نصب:", installId);
  console.log("");
  console.log(key);
} catch (e) {
  console.error("خطا:", e.message);
  process.exit(1);
}
