/**
 * تولیدکننده کلید لایسنس ویزیتو — فقط برای سازنده برنامه (روی سیستم خودتان)
 *
 * کلید خصوصی Ed25519 در keys/license-private.pem است (خارج از گیت — آن را گم نکنید!)
 * کلید عمومی داخل برنامه فقط «تأیید» می‌کند؛ ساخت کلید فقط با همین اسکریپت ممکن است.
 *
 * استفاده:
 *   bun run license:gen -- --name "نام مشتری" --mobile 09121234567 --months 12
 *   bun run license:gen -- --name "فروشگاه x" --mobile 0912... --days 30
 *   bun run license:gen -- --name "..." --mobile "..." --until 2027-01-01
 *   bun run license:gen -- ... --install-id ab12cd34...   (قفل کلید به یک نصب خاص)
 */
import { makeLicenseKey } from "../src/lib/license";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const name = arg("name");
const mobile = arg("mobile") || "-";
const installId = arg("install-id") || "";
const months = arg("months") ? Number(arg("months")) : undefined;
const days = arg("days") ? Number(arg("days")) : undefined;
const until = arg("until");

let expiresAt: Date | null = null;
if (until) expiresAt = new Date(until);
else if (months && months > 0) expiresAt = new Date(Date.now() + months * 30 * 86_400_000);
else if (days && days > 0) expiresAt = new Date(Date.now() + days * 86_400_000);

// امنیت: کلید بدون installId روی هر سروری کار می‌کند — صدورش ممنوع است
if (!installId) {
  console.error("خطا: --install-id الزامی است (شناسه نصب مشتری) — کلید بدون قفل نصب صادر نمی‌شود");
  console.log("استفاده:");
  console.log('  bun run license:gen -- --name "نام مشتری" --mobile 09121234567 --months 12 --install-id ab12cd34');
  process.exit(1);
}

if (!name || !expiresAt || Number.isNaN(expiresAt.getTime())) {
  console.log("استفاده:");
  console.log('  bun run license:gen -- --name "نام مشتری" --mobile 09121234567 --months 12 --install-id ab12cd34');
  console.log("  bun run license:gen -- --name ... --days 30 --install-id ...");
  console.log("  bun run license:gen -- --name ... --until 2027-01-01 --install-id ...");
  process.exit(1);
}

try {
  const key = makeLicenseKey(name, mobile, expiresAt, installId);
  console.log("کلید لایسنس برای:", `${name} (${mobile})`);
  console.log("انقضا:", expiresAt.toISOString().slice(0, 10));
  if (installId) console.log("قفل نصب:", installId);
  console.log("");
  console.log(key);
} catch (e) {
  console.error("خطا:", (e as Error).message);
  console.error("کلید خصوصی باید در keys/license-private.pem باشد (یا env: LICENSE_PRIVATE_KEY_PEM)");
  process.exit(1);
}
