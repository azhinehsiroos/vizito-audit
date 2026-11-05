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
  e: number; // انقضا (epoch ms) — مقدار ۰ یعنی لایسنس «دائمی» بدون تاریخ انقضا
  i: string; // installId نصب مقصد — الزامی (ضد اشتراک‌گذاری کلید)
};

/** کلید دائمی: e = 0 — بدون انقضا، خارج از چرخه مهلت و حذف */
export function isPermanentPayload(p: LicensePayload): boolean {
  return p.e === 0;
}

/** مهلت تمدید ۳۰ روزه پس از انقضای لایسنس مدت‌دار */
export const LICENSE_GRACE_MS = 30 * 86_400_000;

export type LicenseLockPhase =
  | "NOT_ACTIVATED" // بدون لایسنس و بدون ترِیال
  | "TRIAL_OVER" // ترِیال عمومی تمام شده و لایسنی خریداری نشده (پرسنل معاف است)
  | "LICENSE_EXPIRED"; // لایسنس مدت‌دار منقضی شده — در مهلت تمدید ۳۰ روزه یا پس از آن

export type LicenseState = {
  activated: boolean;
  valid: boolean;
  name: string | null;
  mobile: string | null;
  expiresAt: string | null;
  daysLeft: number | null;
  ownerUnlocked?: boolean;
  trial?: boolean;
  permanent?: boolean; // لایسنس دائمی — بدون تاریخ انقضا و خارج از چرخه حذف
  expiredAt?: string | null; // لحظه انقضای مؤثر (فقط وقتی منقضی است)
  graceUntil?: string | null; // پایان مهلت تمدید ۳۰ روزه (فقط وقتی منقضی است)
  graceDaysLeft?: number | null; // روزهای باقی‌مانده مهلت تمدید
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
  // چرخه حیات داده از نو آغاز می‌شود — لاگ حذف قبلی و توقف حذف پاک می‌شود
  await db.setting.deleteMany({ where: { key: { in: ["data_deleted_at", "retention_paused"] } } }).catch(() => {});
  return payload;
}

/** انقضای مؤثر لایسنس: حداکثر انقضای امضاشده کلید و انقضای ثبت‌شده در دفتر فروش (شارژ مجدد) */
function effectiveExpiry(lic: { payload: LicensePayload; saleExpiresAt: Date | null }): number {
  if (isPermanentPayload(lic.payload)) return Number.MAX_SAFE_INTEGER; // دائمی
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
  // (SUPER_ADMIN نقش جدید SaaS + ADMIN قدیمی — سازگاری قبل از بک‌فیل)
  const owner = await db.user.findFirst({ where: { mobile: { in: OWNER_MOBILES }, role: { in: ["SUPER_ADMIN", "ADMIN"] } }, select: { id: true } });
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
  const owner = await db.user.findFirst({ where: { mobile: { in: OWNER_MOBILES }, role: { in: ["SUPER_ADMIN", "ADMIN"] } }, select: { id: true, mobile: true } });
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
  const permanent = isPermanentPayload(lic.payload);
  const valid = !locked && eff > Date.now();
  // مهلت تمدید ۳۰ روزه — فقط برای لایسنس مدت‌دار منقضی‌شده (دائمی هرگز وارد چرخه انقضا نمی‌شود)
  const expired = !locked && !valid && !permanent;
  const graceUntilMs = expired ? eff + LICENSE_GRACE_MS : 0;
  return {
    activated: true,
    valid,
    // اطلاعات دارنده لایسنس فقط برای کاربران واردشده برگردانده می‌شود (در status عمومی حذف می‌شود)
    name: lic.payload.n,
    mobile: lic.payload.m,
    expiresAt: permanent ? null : new Date(eff).toISOString(),
    daysLeft: permanent ? null : Math.ceil((eff - Date.now()) / 86_400_000),
    trial: lic.payload.n.includes("آزمایشی"),
    permanent,
    expiredAt: expired ? new Date(eff).toISOString() : null,
    graceUntil: expired ? new Date(graceUntilMs).toISOString() : null,
    graceDaysLeft: expired ? Math.max(0, Math.ceil((graceUntilMs - Date.now()) / 86_400_000)) : null,
    installId,
  };
}

/**
 * تفکیک فاز قفل لایسنس برای سیاست دسترسی:
 *  - TRIAL_OVER: لایسنس هیچ‌وقت خریداری نشده و ترِیال عمومی تمام شده — پرسنل (STAFF) معاف است
 *  - LICENSE_EXPIRED: لایسنس مدت‌دار منقضی شده — همه (به‌جز مالک) در مهلت/پس از مهلت قفل‌اند
 *  - NOT_ACTIVATED: هیچ لایسنسی فعال نشده
 */
export async function licenseLockPhase(): Promise<LicenseLockPhase> {
  const lic = await getStoredLicense();
  if (lic) return "LICENSE_EXPIRED";
  const t = await trialUntil();
  if (t) return "TRIAL_OVER";
  return "NOT_ACTIVATED";
}

/** جزئیات قفل برای پاسخ ۴۰۲ — شامل وضعیت مهلت تمدید (فقط ساعت سرور) */
export async function licenseLockDetail(): Promise<{
  phase: LicenseLockPhase;
  graceDaysLeft: number | null;
  graceUntil: string | null;
}> {
  const phase = await licenseLockPhase();
  if (phase === "LICENSE_EXPIRED") {
    const state = await getLicenseState();
    return {
      phase,
      graceDaysLeft: state.graceDaysLeft ?? null,
      graceUntil: state.graceUntil ?? null,
    };
  }
  return { phase, graceDaysLeft: null, graceUntil: null };
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

/** پاسخ ۴۰۲ همراه با جزئیات مهلت تمدید — برای مسیرهای احراز هویت‌شده */
export async function licenseLockedResponseDetailed(): Promise<Response> {
  const d = await licenseLockDetail();
  return Response.json(
    {
      error:
        d.phase === "TRIAL_OVER"
          ? "دوره آزمایشی به پایان رسیده است — برای ادامه استفاده لایسنس تهیه کنید (اطلاعات شما محفوظ است)"
          : d.phase === "NOT_ACTIVATED"
            ? "لایسنس هنوز فعال نشده است — کلید لایسنس را وارد کنید (اطلاعات شما محفوظ است)"
            : "لایسنس برنامه منقضی شده است — در مهلت تمدید ۳۰ روزه کلید شارژ را وارد کنید (اطلاعات شما محفوظ است)",
      code: "LICENSE_LOCKED",
      lockPhase: d.phase,
      graceDaysLeft: d.graceDaysLeft,
      graceUntil: d.graceUntil,
    },
    { status: 402 }
  );
}

// ═════════ چندمجموعه‌ای (SaaS v2.0) — لایسنس مستقل هر مجموعه ═════════

export type OrgLockPhase =
  | "ACTIVE"
  | "NOT_ACTIVATED" // مجموعه بدون لایسنس و بدون تریال
  | "TRIAL_OVER" // تریال ۲۴ساعته مجموعه تمام شده
  | "LICENSE_EXPIRED" // لایسنس مدت‌دار منقضی شده (در مهلت یا پس از آن)
  | "SUSPENDED"; // تعلیق مجموعه یا لایسنس توسط سازنده

export type OrgLockState = {
  locked: boolean;
  phase: OrgLockPhase;
  trial: boolean;
  permanent: boolean;
  suspended: boolean;
  trialEndsAt: string | null;
  expiresAt: string | null;
  daysLeft: number | null;
  graceUntil: string | null;
  graceDaysLeft: number | null;
};

/**
 * وضعیت قفل لایسنس «یک مجموعه» — منبع حقیقت فقط سمت سرور:
 *  - تعلیق مجموعه یا لایسنس ← قفل کامل (سیاست تمدید/فعال‌سازی مجدد از پنل سازنده)
 *  - لایسنس دائمی (PERM) یا مدت‌دارِ فعال ← باز
 *  - بدون لایسنس: تریال ۲۴ساعته مجموعه — فقط سمت سرور و فقط هنگام ثبت‌نام نوشته می‌شود
 * سیاست D2: انقضا هیچ‌گاه داده حذف نمی‌کند — فقط دسترسی مدیریتی محدود می‌شود
 * (مهلت ۳۰ روزه فقط برای نمایش شمارش معکوس است، نه حذف).
 */
export async function getOrgLockState(org: {
  id: string;
  status: string;
  trialEndsAt?: Date | string | null;
}): Promise<OrgLockState> {
  const trialEndsAt = org.trialEndsAt ? new Date(org.trialEndsAt) : null;
  const base: OrgLockState = {
    locked: false,
    phase: "ACTIVE",
    trial: false,
    permanent: false,
    suspended: false,
    trialEndsAt: trialEndsAt && !Number.isNaN(trialEndsAt.getTime()) ? trialEndsAt.toISOString() : null,
    expiresAt: null,
    daysLeft: null,
    graceUntil: null,
    graceDaysLeft: null,
  };
  if (org.status === "SUSPENDED") {
    return { ...base, locked: true, phase: "SUSPENDED", suspended: true };
  }
  const license = await db.license.findUnique({ where: { orgId: org.id } });
  if (license) {
    if (license.status === "SUSPENDED") {
      return { ...base, locked: true, phase: "SUSPENDED", suspended: true };
    }
    if (license.expiresAt === null) {
      return { ...base, permanent: true }; // دائمی — بدون انقضا
    }
    const eff = license.expiresAt.getTime();
    if (eff > Date.now()) {
      return {
        ...base,
        expiresAt: license.expiresAt.toISOString(),
        daysLeft: Math.ceil((eff - Date.now()) / 86_400_000),
      };
    }
    const graceUntilMs = eff + LICENSE_GRACE_MS;
    return {
      ...base,
      locked: true,
      phase: "LICENSE_EXPIRED",
      expiresAt: license.expiresAt.toISOString(),
      daysLeft: Math.ceil((eff - Date.now()) / 86_400_000),
      graceUntil: new Date(graceUntilMs).toISOString(),
      graceDaysLeft: Math.max(0, Math.ceil((graceUntilMs - Date.now()) / 86_400_000)),
    };
  }
  // بدون لایسنس — وضعیت تریال مجموعه
  if (!trialEndsAt || Number.isNaN(trialEndsAt.getTime())) {
    return { ...base, locked: true, phase: "NOT_ACTIVATED" };
  }
  if (trialEndsAt.getTime() > Date.now()) {
    return {
      ...base,
      trial: true,
      daysLeft: Math.max(1, Math.ceil((trialEndsAt.getTime() - Date.now()) / 86_400_000)),
    };
  }
  return { ...base, locked: true, phase: "TRIAL_OVER" };
}

/** پاسخ ۴۰۲ برای قفل لایسنس مجموعه — فاز + شناسه مجموعه (پیام پشتیبانی خودکار شناسه را دارد) */
export function orgLockedResponseDetailed(orgId: string, lock: OrgLockState): Response {
  const message =
    lock.phase === "TRIAL_OVER"
      ? "دوره آزمایشی رایگان مجموعه شما به پایان رسیده است — برای ادامه استفاده لایسنس تهیه کنید (اطلاعات شما محفوظ است)"
      : lock.phase === "SUSPENDED"
        ? "مجموعه شما موقتاً توسط پشتیبانی متوقف شده است — با پشتیبانی تماس بگیرید (اطلاعات شما محفوظ است)"
        : lock.phase === "LICENSE_EXPIRED"
          ? "لایسنس مجموعه شما منقضی شده است — برای تمدید با پشتیبانی تماس بگیرید (اطلاعات شما محفوظ است)"
          : "لایسنس مجموعه شما هنوز فعال نشده است — با پشتیبانی تماس بگیرید (اطلاعات شما محفوظ است)";
  return Response.json(
    {
      error: message,
      code: "LICENSE_LOCKED",
      lockPhase: lock.phase,
      orgId,
      trialEndsAt: lock.trialEndsAt,
      expiresAt: lock.expiresAt,
      daysLeft: lock.daysLeft,
      graceDaysLeft: lock.graceDaysLeft,
      graceUntil: lock.graceUntil,
    },
    { status: 402 }
  );
}

// ═════════ VZT3 — کلید لایسنس مستقل هر مجموعه (SaaS v2.0) ═════════
// همان رمزنگاری Ed25519 نسخه ۲ ولی گره‌خورده به «شناسه مجموعه» به‌جای شناسه نصب:
//  - VZT3.<payload>.<signature> — payload: {v:3, o:orgId, e:epoch|0, n?:خریدار}
//  - e = 0 یعنی دائمی
//  - یک کلید فقط یک مجموعه را فعال می‌کند (payload.o) و ثبت hash آن در جدول License
//    جلوی استفاده مجدد همان کلید برای مجموعه دیگر را می‌گیرد.

/** خطای کنترل‌شدهٔ لایسنس — پیام آن مستقیماً به کلاینت برمی‌گردد (بدون جزئیات داخلی) */
export class LicenseControlError extends Error {}

export type OrgLicensePayload = {
  v: 3;
  o: string; // شناسه مجموعه مقصد — یک کلید فقط یک مجموعه
  e: number; // انقضا (epoch ms) — صفر = دائمی
  n?: string; // نام خریدار/مجموعه (نمایشی)
};

/** مدت‌های مجاز صدور — طبق سند تجاری: ۳۰/۹۰/۱۸۰/۳۶۵ روز + دائمی */
export const PLAN_DAYS: Record<string, number> = { D30: 30, D90: 90, D180: 180, D365: 365 };

export function isLicensePlan(v: unknown): v is "D30" | "D90" | "D180" | "D365" | "PERM" {
  return typeof v === "string" && (v === "PERM" || v in PLAN_DAYS);
}

export function licenseKeyHash(key: string): string {
  return crypto.createHash("sha256").update(key.trim()).digest("hex");
}

/** تولید کلید VZT3 (فقط سرور/سیستم سازنده — کلید خصوصی) */
export function makeOrgLicenseKey(orgId: string, expiresAt: Date | null, buyerNote?: string): string {
  if (!orgId || !String(orgId).trim()) {
    throw new LicenseControlError("شناسه مجموعه برای صدور کلید الزامی است");
  }
  const pem = privateKeyPem();
  if (!pem) throw new LicenseControlError("صدور کلید لایسنس روی این سرور فعال نیست (کلید خصوصی موجود نیست)");
  const payload: OrgLicensePayload = {
    v: 3,
    o: String(orgId).trim().slice(0, 40),
    e: expiresAt ? expiresAt.getTime() : 0,
    ...(buyerNote ? { n: String(buyerNote).slice(0, 80) } : {}),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(crypto.sign(null, Buffer.from(body), crypto.createPrivateKey(pem)));
  return `VZT3.${body}.${sig}`;
}

/** اعتبارسنجی ساختار و امضای کلید VZT3 — بدون توجه به انقضا */
export function parseOrgLicenseKey(key: string): OrgLicensePayload | null {
  try {
    const parts = key.trim().split(".");
    if (parts.length !== 3 || parts[0] !== "VZT3") return null;
    const [_, body, sig] = parts;
    if (!body || !sig) return null;
    const ok = crypto.verify(null, Buffer.from(body), publicKey(), fromB64url(sig));
    if (!ok) return null;
    const payload = JSON.parse(fromB64url(body).toString("utf8")) as OrgLicensePayload;
    if (payload.v !== 3 || typeof payload.o !== "string" || !payload.o.trim() || typeof payload.e !== "number") {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function planFromExpiry(expMs: number, nowMs: number): string {
  const days = Math.ceil((expMs - nowMs) / 86_400_000);
  if (days <= 30) return "D30";
  if (days <= 90) return "D90";
  if (days <= 180) return "D180";
  return "D365";
}

/**
 * اعمال کلید VZT3 روی مجموعه — فعال‌سازی یا شارژ مجدد (سمت سرور، ضد سوءاستفاده):
 *  ۱) مجموعه باید موجود و غیرمعلق باشد (رفع تعلیق فقط از سمت سازنده ممکن است)
 *  ۲) کلید منقضی هرگز پذیرفته نمی‌شود — منقضی هرگز چرخه‌ای آغاز نمی‌کند (D2)
 *  ۳) ضد استفاده مجدد: کلیدی که قبلاً روی «مجموعه دیگری» اعمال شده سوخته است
 *  ۴) ضد تنزیل: انقضای جدید باید از انقضای مؤثر فعلی بیشتر باشد؛ PERM بالاتر از همه
 * داده‌های مجموعه در هر حال دست‌نخورده می‌مانند.
 */
export async function activateOrgLicense(
  key: string,
  payload: OrgLicensePayload
): Promise<{ orgId: string; orgName: string; plan: string; expiresAt: Date | null; permanent: boolean; daysLeft: number | null }> {
  const org = await db.org.findUnique({
    where: { id: payload.o },
    select: { id: true, name: true, status: true },
  });
  if (!org) throw new LicenseControlError("این کلید برای مجموعه‌ای معتبر صادر نشده است");
  if (org.status === "SUSPENDED") {
    throw new LicenseControlError("مجموعه شما توسط پشتیبانی متوقف شده است — برای رفع تعلیق با پشتیبانی تماس بگیرید");
  }
  const permanent = payload.e === 0;
  if (!permanent && payload.e < Date.now()) {
    throw new LicenseControlError("این کد لایسنس منقضی شده است — برای تمدید از سازنده کلید جدید بگیرید");
  }
  const kHash = licenseKeyHash(key);
  const usedElsewhere = await db.license.findFirst({
    where: { currentKeyHash: kHash, orgId: { not: org.id } },
    select: { orgId: true },
  });
  if (usedElsewhere) {
    throw new LicenseControlError("این کلید قبلاً برای مجموعه دیگری استفاده شده است");
  }
  const existing = await db.license.findUnique({ where: { orgId: org.id } });
  if (existing) {
    if (existing.status === "SUSPENDED") {
      throw new LicenseControlError("لایسنس این مجموعه توسط پشتیبانی متوقف شده است — با پشتیبانی تماس بگیرید");
    }
    const curEffective =
      existing.expiresAt === null ? Number.MAX_SAFE_INTEGER : existing.expiresAt.getTime();
    if (curEffective === Number.MAX_SAFE_INTEGER) {
      throw new LicenseControlError("لایسنس فعلی این مجموعه دائمی است — کلید جدید جایگزین نمی‌شود");
    }
    if (existing.currentKeyHash === kHash && !permanent && payload.e <= curEffective) {
      throw new LicenseControlError("این کلید قبلاً روی همین مجموعه اعمال شده است — کلید شارژ جدید بگیرید");
    }
    if (!permanent && payload.e <= curEffective) {
      throw new LicenseControlError("این کلید جدیدتر از لایسنس فعلی نیست — کلید شارژ جدید را وارد کنید");
    }
  }
  const plan = permanent ? "PERM" : planFromExpiry(payload.e, Date.now());
  const expiresAt = permanent ? null : new Date(payload.e);
  const daysLeft = permanent ? null : Math.max(1, Math.ceil((payload.e - Date.now()) / 86_400_000));
  if (existing) {
    await db.license.update({
      where: { id: existing.id },
      data: { plan, expiresAt, status: "ACTIVE", currentKeyHash: kHash },
    });
  } else {
    await db.license.create({
      data: {
        orgId: org.id,
        plan,
        startsAt: new Date(),
        expiresAt,
        status: "ACTIVE",
        source: "KEY",
        currentKeyHash: kHash,
      },
    });
  }
  await db.licenseEvent
    .create({
      data: {
        orgId: org.id,
        type: "ACTIVATE",
        plan,
        actorName: payload.n ? `فعال‌سازی کلید (${payload.n})` : "فعال‌سازی کلید",
        note: permanent ? "لایسنس دائمی با کلید VZT3" : `اعتبار تا ${expiresAt!.toISOString()}`,
      },
    })
    .catch(() => {});
  return { orgId: org.id, orgName: org.name, plan, expiresAt, permanent, daysLeft };
}
