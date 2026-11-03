import crypto from "crypto";
import fs from "fs";
import path from "path";
import { db } from "@/lib/db";

/**
 * سیستم لایسنس مدت‌دار ویزیتو (نسخه ۲ — امضای نامتقارن Ed25519)
 * ------------------------------------------------------
 * - کلید لایسنس VZT2 با Ed25519 امضا می‌شود: VZT2.<payload>.<signature>
 *   • کلید خصوصی فقط روی سیستم سازنده است (keys/license-private.pem یا env: LICENSE_PRIVATE_KEY_PEM)
 *   • در سورس برنامه فقط کلید «عمومی» هست ⇒ حتی با دسترسی به کد سرور، ساخت کلید جعلی ممکن نیست
 *   • هر کلید به installId یک نصب خاص قفل می‌شود (کلید روی سرورهای دیگر کار نمی‌کند)
 * - نسخه قدیمی VZT1 (HMAC با secret داخل سورس) کاملاً حذف شد — کلیدهای قبلی دیگر معتبر نیستند
 *   (چون secret آن لو رفته بود، همه کلیدهای VZT1 جعلی تلقی می‌شوند)
 * - وقتی لایسنس فعال/معتبر نیست، همه APIها 402 برمی‌گردانند و اپ صفحه قفل نشان می‌دهد
 * - مهم: با انقضای لایسنس هیچ داده‌ای حذف نمی‌شود؛ با ورود کلید جدید همه‌چیز ادامه می‌یابد
 */

// ---------- کلیدهای امضا ----------

// کلید عمومی امضای لایسنس (عمومی‌کردنش بی‌خطر است) — برای چرخش کلید: env: LICENSE_PUBLIC_KEY_PEM
export const LICENSE_PUBLIC_KEY_PEM =
  process.env.LICENSE_PUBLIC_KEY_PEM ||
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEALPavtjcuXbtk+NiS0cBW43I+WwDpbqPKGPPUeOLifbA=
-----END PUBLIC KEY-----`;

function publicKey(): crypto.KeyObject {
  return crypto.createPublicKey(LICENSE_PUBLIC_KEY_PEM);
}

/**
 * کلید خصوصی فقط در این موارد موجود است:
 *  ۱) سیستم سازنده: فایل keys/license-private.pem (خارج از گیت)
 *  ۲) سرور خودِ سازنده (برای صدور کلید از داخل پنل فروش): env: LICENSE_PRIVATE_KEY_PEM
 * روی سرورهای مشتریان هیچ‌کدام نیست ⇒ صدور کلید از پنل غیرفعال است (فقط شارژ مجدد کار می‌کند)
 */
function privateKeyPem(): string | null {
  const env = process.env.LICENSE_PRIVATE_KEY_PEM;
  if (env && env.includes("PRIVATE KEY")) return env;
  try {
    const p = path.join(process.cwd(), "keys", "license-private.pem");
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** آیا این سرور مجاز به صدور کلید جدید است؟ (فقط سرور سازنده) */
export function canIssueKeys(): boolean {
  return privateKeyPem() !== null;
}

// ---------- موبایل‌های سازنده (دسترسی همیشگی) ----------

/**
 * موبایل‌های سازنده برنامه — دسترسی کلی و همیشگی بدون لایسنس.
 * امنیت:
 *  - شماره‌ها «داخل سورس/باندل عمومی» نوشته نمی‌شوند — فقط از env: OWNER_MOBILES خوانده می‌شوند
 *    (مثال: OWNER_MOBILES=0917xxxxxxx,0917yyyyyyy) — بدون این متغیر، هیچ شماره‌ای ویژه نیست
 *  - مدیران دیگر نمی‌توانند کاربری با این شماره‌ها بسازند/ویرایش کنند (users/route.ts)
 *  - ثبت‌نام با این شماره‌ها فقط با «کلید راه‌اندازی» سازنده ممکن است (env: OWNER_SETUP_KEY)
 *  - بنابراین فقط خود سازنده می‌تواند چنین حسابی روی یک سرور داشته باشد
 */
export const OWNER_MOBILES: string[] = (process.env.OWNER_MOBILES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function isOwnerMobile(mobile: string | null | undefined): boolean {
  return !!mobile && OWNER_MOBILES.includes(mobile);
}

// ---------- payload و کلید ----------

export type LicensePayload = {
  v: 2;
  n: string; // نام مشتری / شرکت
  m: string; // موبایل
  e: number; // انقضا (epoch ms)
  i: string; // installId نصب مقصد — الزامی (ضد اشتراک‌گذاری کلید)
};

export type LicenseState = {
  activated: boolean;
  valid: boolean;
  name: string | null;
  mobile: string | null;
  expiresAt: string | null;
  daysLeft: number | null;
  ownerUnlocked?: boolean;
  trial?: boolean;
  installId?: string;
};

const SETTING_KEY = "license_v1";
const INSTALL_KEY = "install_id";
const TRIAL_KEY = "trial_until";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** شناسه نصب — تصادفی و ماندگار در دیتابیس؛ برای قفل‌کردن کلید لایسنس به یک سرور خاص */
export async function getInstallId(): Promise<string> {
  const row = await db.setting.findUnique({ where: { key: INSTALL_KEY } });
  if (row?.value) return row.value;
  const id = crypto.randomBytes(8).toString("hex");
  try {
    await db.setting.create({ data: { key: INSTALL_KEY, value: id } });
  } catch {
    // race: همزمانی — مقدار نوشته‌شده را بخوان
  }
  const again = await db.setting.findUnique({ where: { key: INSTALL_KEY } });
  return again?.value || id;
}

/** تولید کلید لایسنس VZT2 (فولدر سازنده / سرور دارای کلید خصوصی) — installId الزامی */
export function makeLicenseKey(name: string, mobile: string, expiresAt: Date, installId: string): string {
  if (!installId || !installId.trim()) {
    throw new Error("installId الزامی است — کلید بدون قفل نصب صادر نمی‌شود (ضد اشتراک‌گذاری)");
  }
  const pem = privateKeyPem();
  if (!pem) throw new Error("صدور کلید لایسنس روی این سرور فعال نیست (کلید خصوصی موجود نیست)");
  const payload: LicensePayload = {
    v: 2,
    n: name.slice(0, 80),
    m: mobile.slice(0, 20),
    e: expiresAt.getTime(),
    i: installId.trim().slice(0, 40),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(crypto.sign(null, Buffer.from(body), crypto.createPrivateKey(pem)));
  return `VZT2.${body}.${sig}`;
}

/** اعتبارسنجی ساختار و امضای کلید — بدون توجه به انقضا (فقط VZT2؛ VZT1 به‌کلی باطل شده) */
export function parseLicenseKey(key: string): LicensePayload | null {
  try {
    const parts = key.trim().split(".");
    if (parts.length !== 3 || parts[0] !== "VZT2") return null;
    const [_, body, sig] = parts;
    if (!body || !sig) return null;
    const ok = crypto.verify(null, Buffer.from(body), publicKey(), fromB64url(sig));
    if (!ok) return null;
    const payload = JSON.parse(fromB64url(body).toString("utf8")) as LicensePayload;
    if (payload.v !== 2 || typeof payload.e !== "number" || typeof payload.n !== "string") return null;
    return payload;
  } catch {
    return null;
  }
}

/** لایسنس ذخیره‌شده در دیتابیس (پس از فعال‌سازی) — انقضای مؤثر از دفتر فروش هم خوانده می‌شود */
export async function getStoredLicense(): Promise<{
  key: string;
  payload: LicensePayload;
  activatedAt: string;
  saleExpiresAt: Date | null; // انقضای مؤثر ثبت‌شده در دفتر فروش (شارژ مجدد بدون کلید جدید)
} | null> {
  const row = await db.setting.findUnique({ where: { key: SETTING_KEY } });
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { key: string; activatedAt: string };
    const payload = parseLicenseKey(parsed.key);
    if (!payload) return null;
    // اگر این کلید در دفتر فروش لایسنس ثبت شده باشد، انقضای مؤثر همان رکورد است (سرور مرجع)
    const sale = await db.licenseSale.findFirst({ where: { key: parsed.key }, select: { expiresAt: true } });
    return { key: parsed.key, payload, activatedAt: parsed.activatedAt, saleExpiresAt: sale?.expiresAt ?? null };
  } catch {
    return null;
  }
}

/** شروع دوره آزمایشی ۲۴ ساعته — فقط سرور و فقط برای اولین ثبت‌نام (نشانگر داخلی، نه کلید امضاشده) */
export async function startTrial(hours = 24): Promise<void> {
  const existing = await db.setting.findUnique({ where: { key: TRIAL_KEY } });
  if (existing) return; // فقط یک‌بار
  const until = new Date(Date.now() + hours * 3_600_000);
  await db.setting.upsert({ where: { key: TRIAL_KEY }, update: { value: until.toISOString() }, create: { key: TRIAL_KEY, value: until.toISOString() } });
}

async function trialUntil(): Promise<Date | null> {
  const row = await db.setting.findUnique({ where: { key: TRIAL_KEY } });
  if (!row) return null;
  const d = new Date(row.value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** فعال‌سازی/شارژ مجدد لایسنس با کلید جدید — داده‌ها دست‌نخورده می‌مانند */
export async function activateLicense(key: string): Promise<LicensePayload> {
  const payload = parseLicenseKey(key);
  if (!payload) throw new Error("کلید لایسنس نامعتبر است");
  // قفل نصب: کلید صادرشده برای نصب دیگر پذیرفته نمی‌شود
  if (payload.v === 2 && payload.i) {
    const here = await getInstallId();
    if (payload.i !== here) throw new Error("این کلید برای این نصب صادر نشده است");
  }
  const value = JSON.stringify({ key: key.trim(), activatedAt: new Date().toISOString() });
  await db.setting.upsert({
    where: { key: SETTING_KEY },
    update: { value },
    create: { key: SETTING_KEY, value },
  });
  // با فعال‌شدن لایسنس واقعی، دوره آزمایشی بی‌معناست
  await db.setting.deleteMany({ where: { key: TRIAL_KEY } }).catch(() => {});
  return payload;
}

/** انقضای مؤثر لایسنس: حداکثر انقضای امضاشده کلید و انقضای ثبت‌شده در دفتر فروش (شارژ مجدد) */
function effectiveExpiry(lic: { payload: LicensePayload; saleExpiresAt: Date | null }): number {
  const signed = lic.payload.e;
  const sale = lic.saleExpiresAt ? lic.saleExpiresAt.getTime() : 0;
  return Math.max(signed, sale);
}

async function installLocked(lic: { payload: LicensePayload }): Promise<boolean> {
  const here = await getInstallId();
  return lic.payload.i !== here; // کلیدهای VZT2 همیشه installId دارند (الزامی)
}

export async function isLicenseValid(): Promise<boolean> {
  // دسترسی همیشگی سازنده: اگر مدیر با موبایل سازنده روی این سرور ثبت شده باشد، قفل برداشته است
  const owner = await db.user.findFirst({ where: { mobile: { in: OWNER_MOBILES }, role: "ADMIN" }, select: { id: true } });
  if (owner) return true;
  const lic = await getStoredLicense();
  if (lic) {
    if (await installLocked(lic)) return false;
    if (effectiveExpiry(lic) > Date.now()) return true;
  }
  // دوره آزمایشی ۲۴ ساعته (نشانگر داخلی سرور — فقط هنگام اولین ثبت‌نام نوشته می‌شود)
  const t = await trialUntil();
  return !!t && t.getTime() > Date.now();
}

/** وضعیت کامل لایسنس برای نمایش */
export async function getLicenseState(): Promise<LicenseState> {
  const installId = await getInstallId();
  const owner = await db.user.findFirst({ where: { mobile: { in: OWNER_MOBILES }, role: "ADMIN" }, select: { id: true, mobile: true } });
  if (owner) {
    return {
      activated: true,
      valid: true,
      name: "دسترسی همیشگی سازنده برنامه",
      mobile: owner.mobile,
      expiresAt: null,
      daysLeft: null,
      ownerUnlocked: true,
      installId,
    };
  }
  const lic = await getStoredLicense();
  if (!lic) {
    // دوره آزمایشی؟
    const t = await trialUntil();
    if (t && t.getTime() > Date.now()) {
      const daysLeft = Math.ceil((t.getTime() - Date.now()) / 86_400_000);
      return {
        activated: true,
        valid: true,
        name: "دوره آزمایشی رایگان",
        mobile: null,
        expiresAt: t.toISOString(),
        daysLeft,
        trial: true,
        installId,
      };
    }
    return { activated: false, valid: false, name: null, mobile: null, expiresAt: null, daysLeft: null, installId };
  }
  const locked = await installLocked(lic);
  const eff = effectiveExpiry(lic);
  const daysLeft = Math.ceil((eff - Date.now()) / 86_400_000);
  const valid = !locked && eff > Date.now();
  return {
    activated: true,
    valid,
    // اطلاعات دارنده لایسنس فقط برای کاربران واردشده برگردانده می‌شود (در status عمومی حذف می‌شود)
    name: lic.payload.n,
    mobile: lic.payload.m,
    expiresAt: new Date(eff).toISOString(),
    daysLeft,
    trial: lic.payload.n.includes("آزمایشی"),
    installId,
  };
}

/** پاسخ استاندارد 402 برای قفل لایسنس */
export function licenseLockedResponse(): Response {
  return Response.json(
    {
      error: "لایسنس برنامه منقضی یا فعال نشده است — لطفاً کلید لایسنس را وارد یا شارژ کنید (اطلاعات شما محفوظ است)",
      code: "LICENSE_LOCKED",
    },
    { status: 402 }
  );
}
