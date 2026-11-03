import { NextRequest } from "next/server";
import crypto from "crypto";
import { promisify } from "util";
import { db } from "@/lib/db";
import { isLicenseValid, licenseLockedResponse } from "@/lib/license";

/**
 * سیستم توکن مبتنی بر نشست سمت سرور:
 * - توکن = ۳۲ بایت تصادفی امن (هیچ secret یا داده‌ای داخل توکن نیست)
 * - فقط هش SHA-256 توکن در دیتابیس ذخیره می‌شود (نشت دیتابیس ⇒ سوءاستفاده از توکن ممکن نیست)
 * - هر درخواست اعتبار نشست را در دیتابیس چک می‌کند ⇒ خروج/ابطال فوری
 * - انقضای نشست: ۳۰ روز
 */
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // ۳۰ روز

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * ساخت نشست جدید و برگرداندن توکن متنی (فقط همین لحظه در خروجی API دیده می‌شود)
 */
export async function newToken(uid: string, role: string, userAgent?: string | null): Promise<string> {
  void role; // نقش همیشه از دیتابیس خوانده می‌شود — در توکن اعتماد نمی‌شود
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.authSession.create({
    data: { tokenHash: hashToken(token), userId: uid, userAgent: userAgent?.slice(0, 180) || null, expiresAt },
  });
  // پاک‌سازی نشست‌های منقضی (فرصتی سبک برای بهداشت دیتابیس)
  db.authSession.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
  return token;
}

/** حذف نشست (خروج از حساب) */
export async function revokeToken(token: string): Promise<void> {
  await db.authSession.deleteMany({ where: { tokenHash: hashToken(token) } });
}

/** برقراری نشست از روی توکن — در صورت انقضا، نشست حذف و null برمی‌گردد */
async function findSession(token: string) {
  const session = await db.authSession.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await db.authSession.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  return session;
}

// scrypt ناهمگام — event loop بلاک نمی‌شود (نسخه sync باعث فریز سرور زیر بار می‌شد)
const scryptAsync = promisify(crypto.scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number
) => Promise<Buffer>;

export function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  return scryptAsync(password, salt, 64).then((h) => `${salt}:${h.toString("hex")}`);
}

// هش الکی برای هم‌زمان‌سازی زمانی: وقتی کاربر وجود ندارد هم همان هزینه scrypt پرداخت می‌شود
// تا تفاوت زمانیِ «کاربر وجود ندارد / رمز غلط» قابل اندازه‌گیری نباشد
const DUMMY_HASH =
  "c5ec2a15177a4c4da952ae6463f9cba2:22b0eb4e87c786fbc7e3e3f55b99ac5b83d605de336b4cbff10566dcc6ff15fff408ad4833993db8f0ee76bc6fc6138e7e1570d3df846bae86a906c9592cc623";

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = await scryptAsync(password, salt, 64);
  const original = Buffer.from(hash, "hex");
  return candidate.length === original.length && crypto.timingSafeEqual(candidate, original);
}

/** تأیید رمز با هم‌زمان‌سازی زمانی — برای ورود: وقتی کاربر پیدا نشد هم scrypt اجرا می‌شود */
export async function verifyPasswordSafe(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    await verifyPassword(password, DUMMY_HASH);
    return false;
  }
  return verifyPassword(password, stored);
}

/** حداقل طول رمز عبور */
export const PASSWORD_MIN_LENGTH = 8;

/** اعتبارسنجی رمز عبور — پیام خطای یکسان در همه مسیرها */
export function passwordError(password: string): string | null {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH || password.length > 72) {
    return `رمز عبور باید حداقل ${PASSWORD_MIN_LENGTH} و حداکثر ۷۲ کاراکتر باشد`;
  }
  return null;
}

export type AuthContext = {
  user: {
    id: string;
    mobile: string;
    name: string;
    company: string | null;
    role: string;
  };
  sections: string[]; // دسترسی‌های فعال
  grantExpiresAt: string | null;
  isAdmin: boolean;
};

/** نام کوکی نشست — HttpOnly یعنی جاوااسکریپت (و XSS) به توکن دسترسی ندارد */
export const SESSION_COOKIE = "vizito_session";

/**
 * کلید «رزرو اولین مدیر» در جدول Setting — ضد رقابت هم‌زمان:
 * ساخت این ردیف (با key یکتا) فقط یک‌بار ممکن است؛ برنده آن ثبت‌نام، مدیر اول می‌شود
 */
export const FIRST_ADMIN_CLAIM_KEY = "first_admin_claim";

/**
 * هدر Set-Cookie برای نشست — توکن دیگر در localStorage ذخیره نمی‌شود
 * HttpOnly ⇒ XSS نمی‌تواند توکن را بخواند
 * SameSite:
 *  - HTTP (توسعه محلی/APK روی شبکه داخلی): Strict — امن‌ترین حالت
 *  - HTTPS: None + Secure + Partitioned (CHIPS) — تا کوکی در بستر «iframe بین‌سایتی»
 *    (مثل پیش‌نمایش داخل پنل‌های میزبان) هم ذخیره و ارسال شود؛ در استفاده معمولی
 *    (تب مستقل/APK) هیچ تفاوتی ایجاد نمی‌کند. CSRF همچنان مسدود است چون همه تغییرات
 *    با POST + Content-Type: application/json هستند که درخواست بین‌سایتی بدون CORS ممکن نیست.
 */
export function sessionCookie(req: NextRequest, token: string | null): string {
  const proto = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim();
  const isHttps = proto === "https" || new URL(req.url).protocol === "https:";
  const parts = [
    `${SESSION_COOKIE}=${token || ""}`,
    "Path=/",
    "HttpOnly",
    isHttps ? "SameSite=None" : "SameSite=Strict",
    token ? `Max-Age=${60 * 60 * 24 * 30}` : "Max-Age=0", // ۳۰ روز / حذف فوری
  ];
  if (isHttps) {
    parts.push("Secure");
    parts.push("Partitioned");
  }
  return parts.join("; ");
}

function extractToken(req: NextRequest): string | null {
  // اولویت: هدر Authorization (سازگاری با نسخه‌های قبلی اپ) — سپس کوکی HttpOnly
  const header = req.headers.get("authorization") || "";
  if (header.startsWith("Bearer ")) {
    const t = header.slice(7).trim();
    if (t) return t;
  }
  return req.cookies.get(SESSION_COOKIE)?.value || null;
}

export async function getAuth(req: NextRequest): Promise<AuthContext | null> {
  const token = extractToken(req);
  if (!token) return null;
  const session = await findSession(token);
  if (!session) return null;
  const user = await db.user.findUnique({
    where: { id: session.userId },
    include: { grants: { orderBy: { createdAt: "desc" } } },
  });
  if (!user) return null;
  if (user.role === "ADMIN") {
    return {
      user: {
        id: user.id,
        mobile: user.mobile,
        name: user.name,
        company: user.company,
        role: user.role,
      },
      sections: ALL_SECTIONS,
      grantExpiresAt: null,
      isAdmin: true,
    };
  }
  // کاربر عادی: جدیدترین گرنت معتبر
  const now = new Date();
  const validGrants = user.grants.filter((g) => g.expiresAt > now);
  if (validGrants.length === 0) {
    return {
      user: {
        id: user.id,
        mobile: user.mobile,
        name: user.name,
        company: user.company,
        role: user.role,
      },
      sections: [],
      grantExpiresAt: null,
      isAdmin: false,
    };
  }
  const grant = validGrants[0];
  let sections: string[] = [];
  try {
    sections = JSON.parse(grant.sections);
  } catch {
    sections = [];
  }
  return {
    user: {
      id: user.id,
      mobile: user.mobile,
      name: user.name,
      company: user.company,
      role: user.role,
    },
    sections,
    grantExpiresAt: grant.expiresAt.toISOString(),
    isAdmin: false,
  };
}

/** توکن خام از هدر — برای خروج از حساب */
export function getTokenFromRequest(req: NextRequest): string | null {
  return extractToken(req);
}

export const ALL_SECTIONS = [
  "dashboard",
  "customers",
  "products",
  "orders",
  "reports",
  "catalogs",
  "users",
  "purchase_price",
  "all_customers",
];

/** آیا این کاربر مجاز به دیدن قیمت خرید است (مدیر یا کاربر دارای دسترسی ویژه) */
export function canSeePurchasePrice(ctx: AuthContext): boolean {
  return ctx.isAdmin || ctx.sections.includes("purchase_price");
}

/**
 * آیا این کاربر به «تمام مشتری‌ها» دسترسی دارد؟
 * مدیر همیشه همه مشتری‌ها را می‌بیند؛ کاربر عادی فقط مشتری‌های خودش را،
 * مگر اینکه مدیر مجوز ویژه all_customers برایش فعال کرده باشد.
 */
export function canSeeAllCustomers(ctx: AuthContext): boolean {
  return ctx.isAdmin || ctx.sections.includes("all_customers");
}

export function unauthorized(message = "احراز هویت نشده است") {
  return Response.json({ error: message }, { status: 401 });
}

export function forbidden(message = "دسترسی به این بخش ندارید") {
  return Response.json({ error: message }, { status: 403 });
}

export function tooMany(retryAfterSeconds: number, message?: string) {
  return Response.json(
    { error: message || `تلاش‌های زیاد — لطفاً ${Math.ceil(retryAfterSeconds / 60)} دقیقه دیگر دوباره تلاش کنید` },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
  );
}

/**
 * گیت ضد CSRF برای «همه» مسیرهای تغییردهنده — شامل مسیرهای عمومیِ بدون نشست
 * (ورود/ثبت‌نام/خروج/فعال‌سازی لایسنس) که از requireAuth عبور نمی‌کنند.
 * تحلیل امنیتی:
 *  ۱) fetch بین‌سایتی با Content-Type: application/json ⇒ preflight ⇒ این API
 *     هیچ هدر CORS صادر نمی‌کند ⇒ مرورگر خودش بلاک می‌کند
 *  ۲) تنها برد عملی مهاجم: ارسال فرم HTML/text/plain بدون preflight
 *     (تلاش برای login CSRF / ثبت‌نام بین‌سایتی) — همین لایه آن را ۴۰۳ می‌کند
 *  ۳) اپ خود برنامه همیشه application/json می‌فرستد (src/lib/api.ts) ⇒ سازگاری کامل
 *  ⚠️ بررسی مبدأ (Origin) عمداً وجود ندارد: پشت پروکسی‌های بازنویسی‌کننده Host
 *     مقایسهٔ مبدأ، درخواست مشروع را رد می‌کرد (نسخه ۱.۰.۵ — حذف‌شده نهایی)
 */
export function jsonContentTypeGate(req: NextRequest): Response | null {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return null;
  const ct = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (ct && ct !== "application/json") {
    console.warn("vizito csrf-block:", req.method, new URL(req.url).pathname, {
      ct,
      origin: req.headers.get("origin"),
      host: req.headers.get("host"),
    });
    return forbidden("درخواست بین‌دامنه‌ای مجاز نیست");
  }
  return null;
}

/** احراز هویت + بررسی دسترسی به یک بخش (مدیر همیشه مجاز) + قفل لایسنس (402) */
export async function requireAuth(
  req: NextRequest,
  section?: string
): Promise<{ ctx: AuthContext } | { error: Response }> {
  // ── ضد CSRF — الزام Content-Type: application/json برای درخواست‌های تغییردهنده ──
  // تحلیل امنیتی کامل در jsonContentTypeGate — اینجا همان لایه استفاده می‌شود.
  const csrf = jsonContentTypeGate(req);
  if (csrf) return { error: csrf };
  const ctx = await getAuth(req);
  if (!ctx) return { error: unauthorized() };
  // قفل لایسنس: بدون لایسنس فعال/معتبر هیچ API احراز هویت‌شده‌ای کار نمی‌کند (داده‌ها حذف نمی‌شوند)
  if (!(await isLicenseValid())) return { error: licenseLockedResponse() };
  if (section && !ctx.isAdmin && !ctx.sections.includes(section)) {
    return { error: forbidden(`دسترسی به بخش «${section}» برای شما فعال نیست یا منقضی شده است`) };
  }
  return { ctx };
}
