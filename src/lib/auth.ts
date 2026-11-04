import { NextRequest } from "next/server";
import crypto from "crypto";
import { promisify } from "util";
import { db } from "@/lib/db";
import {
  isLicenseValid,
  licenseLockPhase,
  licenseLockedResponseDetailed,
} from "@/lib/license";

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
    kind: string; // STAFF (پرسنل مدیر) | PUBLIC (کاربر عمومی)
  };
  sections: string[]; // دسترسی‌های فعال
  grantExpiresAt: string | null; // null در گرنت دائمی یا مدیر
  isAdmin: boolean;
  /** ترِیال شخصی فعال کاربر عمومی — برای نمایش شمارش معکوس در UI */
  trialUntil?: string | null;
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
  // حساب غیرفعال — همه نشست‌ها عملاً بی‌اعتبار می‌شوند (سیاست سمت سرور، نه فقط UI)
  if (user.disabled) return null;
  const kind = user.kind || "STAFF";
  if (user.role === "ADMIN") {
    return {
      user: {
        id: user.id,
        mobile: user.mobile,
        name: user.name,
        company: user.company,
        role: user.role,
        kind,
      },
      sections: ALL_SECTIONS,
      grantExpiresAt: null,
      isAdmin: true,
    };
  }
  const now = new Date();
  // گرنت دائمی (expiresAt = null) همیشه معتبر است — سقف ۵/۱۰ ساله حذف شد
  const validGrants = user.grants.filter((g) => g.expiresAt === null || g.expiresAt > now);
  if (validGrants.length === 0) {
    // ترِیال شخصی ۲۴ ساعته کاربر عمومی — دسترسی کامل (به‌جز مدیریت کاربران)
    // فقط یک‌بار هنگام ثبت‌نام نوشته می‌شود؛ با ساخت حساب جدید قابل تکرار توسط همان شماره نیست
    if (kind === "PUBLIC" && user.trialUntil && user.trialUntil > now) {
      return {
        user: {
          id: user.id,
          mobile: user.mobile,
          name: user.name,
          company: user.company,
          role: user.role,
          kind,
        },
        sections: ALL_SECTIONS.filter((s) => s !== "users"),
        grantExpiresAt: user.trialUntil.toISOString(),
        isAdmin: false,
        trialUntil: user.trialUntil.toISOString(),
      };
    }
    return {
      user: {
        id: user.id,
        mobile: user.mobile,
        name: user.name,
        company: user.company,
        role: user.role,
        kind,
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
      kind,
    },
    sections,
    grantExpiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
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
 *
 * لایه ۱ — Content-Type سخت‌گیرانه:
 *  هر درخواست POST/PUT/PATCH/DELETE «باید» Content-Type: application/json داشته باشد.
 *  Content-Type خالی، text/plain، form-urlencoded و multipart همه رد می‌شوند.
 *  تحلیل امنیتی:
 *   ۱) fetch بین‌سایتی با application/json ⇒ preflight ⇒ این API هیچ هدر CORS
 *      صادر نمی‌کند ⇒ مرورگر خودش بلاک می‌کند
 *   ۲) تنها برد عملی مهاجم: فرم HTML/text/plain/form-urlencoded بدون preflight
 *      (login CSRF / ثبت‌نام بین‌سایتی) — همین لایه همه را ۴۰۳ می‌کند
 *   ۳) اپ خود برنامه همیشه application/json می‌فرستد (src/lib/api.ts) ⇒ سازگاری کامل
 *
 * لایه ۲ — بررسی مبدأ (Origin / Referer):
 *  - اگر درخواست Origin یا Referer داشته باشد، hostname آن باید با hostname
 *    «مبدأ مؤثر خود درخواست» (x-forwarded-host یا host) یا یکی از مبدأهای مجاز
 *    env: VIZITO_ALLOWED_ORIGINS (مثلاً دامنه www و بدون-www) یکی باشد؛
 *    وگرنه ۴۰۳. (مقایسه بر اساس hostname است تا اختلاف پروتکلِ ناشی از پروکسی
 *    بین‌لایه‌ای درخواست مشروع را رد نکند؛ مهاجم بین‌سایتی hostname متفاوت دارد.)
 *  - اگر سرور پشت پروکسی‌ای است که هیچ هدری از مبدأ واقعی مرورگر را منتقل
 *    نمی‌کند، دامنه برنامه را در VIZITO_ALLOWED_ORIGINS تنظیم کنید.
 *  - ورودی‌های VIZITO_ALLOWED_ORIGINS می‌توانند wildcard پسوندی باشند:
 *    «*.example.com» یا «.example.com» ⇒ هر زیردامنه example.com مجاز است
 *    (نقطهٔ ابتدایی جلوی جعل پسوند مثل evil-example.com را می‌گیرد).
 *  - مبدأ «داخلی» (localhost/127.x/10.x/192.168.x/172.16-31.x/بدون نقطه) بررسی
 *    نمی‌شود تا توسعه محلی، شبکه داخلی و ابزارهای تست نشکند.
 *  - نبودن هر دو هدر (کلاینت غیرمرورگری مثل curl و WebView خاص) مجاز است —
 *    مرورگرها در درخواست تغییردهنده بین‌سایتی همیشه Origin می‌فرستند.
 *  - Origin برابر رشته «null» (iframe سندباکس‌شده/file://) رد می‌شود.
 */
export function csrfGate(req: NextRequest): Response | null {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return null;

  const block = (reason: string, presented: string | null) => {
    console.warn("vizito csrf-block:", req.method, new URL(req.url).pathname, {
      reason,
      presented,
      host: req.headers.get("host"),
      forwardedHost: req.headers.get("x-forwarded-host"),
    });
    return forbidden("درخواست بین‌دامنه‌ای مجاز نیست");
  };

  // ── لایه ۱: Content-Type ──
  const ct = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (ct !== "application/json") {
    return block("content-type", ct || "(empty)");
  }

  // ── لایه ۲: Origin / Referer ──
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  if (!origin && !referer) return null; // کلاینت غیرمرورگری — CSRF مرورگری نیست

  const presentedRaw = origin || referer || "";
  const presented = originOf(presentedRaw);
  if (!presented) return block("unparsable-origin", presentedRaw.slice(0, 60));

  const effective = effectiveOriginOf(req);
  // مبدأ داخلی (توسعه/شبکه محلی/ابزار تست) — بررسی نمی‌شود
  if (isInternalHostname(hostnameOf(effective))) return null;

  const allowedHostnames = new Set<string>();
  const allowedSuffixes: string[] = []; // wildcard پسوندی: «.example.com» ⇒ هر زیردامنه
  if (effective) allowedHostnames.add(hostnameOf(effective));
  for (const o of (process.env.VIZITO_ALLOWED_ORIGINS || "").split(",")) {
    const trimmed = o.trim().replace(/\/+$/, "");
    if (!trimmed) continue;
    if (trimmed.startsWith("*.") || trimmed.startsWith(".")) {
      const suffix = trimmed.replace(/^\*/, "");
      if (suffix.length > 2 && suffix.includes(".")) {
        allowedSuffixes.push(suffix.toLowerCase());
        continue;
      }
    }
    const h = hostnameOf(trimmed);
    if (h) allowedHostnames.add(h);
  }
  const presentedHost = presented.hostname;
  const suffixOk = allowedSuffixes.some((s) => presentedHost.endsWith(s));
  if (!allowedHostnames.has(presentedHost) && !suffixOk) {
    return block("cross-origin", presented.origin);
  }
  return null;
}

/** استخراج مبدأ (scheme://host) از یک URL/Origin/Referer — نامعتبر ⇒ null */
function originOf(value: string): { hostname: string; origin: string } | null {
  try {
    const u = new URL(value);
    return { hostname: u.hostname.toLowerCase(), origin: `${u.protocol}//${u.host}`.toLowerCase() };
  } catch {
    return null;
  }
}

/** مبدأ مؤثر خودِ درخواست با احترام به زنجیره پروکسی (XFH و XFP) */
function effectiveOriginOf(req: NextRequest): string {
  const fwdHost = (req.headers.get("x-forwarded-host") || "").split(",")[0].trim();
  const host = fwdHost || (req.headers.get("host") || "").trim();
  const fwdProto = (req.headers.get("x-forwarded-proto") || "").split(",")[0].trim();
  const proto = fwdProto || (req.url.startsWith("https") ? "https" : "http");
  return host ? `${proto.toLowerCase()}://${host.toLowerCase()}` : "";
}

function hostnameOf(origin: string): string {
  if (!origin) return "";
  if (!origin.includes("://")) return origin.toLowerCase();
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** آیا hostname داخلی/محلی است؟ (توسعه محلی، شبکه داخلی، ابزارهای تست) */
function isInternalHostname(hostname: string): boolean {
  const h = (hostname || "").toLowerCase();
  if (!h) return true; // بدون host — محیط غیر HTTP
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "[::1]") return true;
  if (!h.includes(".")) return true; // hostname داخلی بدون نقطه
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  const m = /^172\.(\d{1,2})\./.exec(h);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  return false;
}

/** احراز هویت + بررسی دسترسی به یک بخش (مدیر همیشه مجاز) + قفل لایسنس (402) */
export async function requireAuth(
  req: NextRequest,
  section?: string
): Promise<{ ctx: AuthContext } | { error: Response }> {
  // ── ضد CSRF — Content-Type سخت‌گیرانه + بررسی مبدأ (Origin/Referer) ──
  // تحلیل امنیتی کامل در csrfGate — اینجا همان لایه برای همه مسیرهای احراز هویت‌شده استفاده می‌شود
  const csrf = csrfGate(req);
  if (csrf) return { error: csrf };
  const ctx = await getAuth(req);
  if (!ctx) return { error: unauthorized() };
  // قفل لایسنس (402) با تفکیک فاز:
  //  - حساب مالک هیچ‌وقت قفل نمی‌شود (isLicenseValid برای مالک true است)
  //  - پرسنل (STAFF) فقط از قفل «پایان ترِیال عمومی» معاف است — انقضای خود لایسنس همه را قفل می‌کند
  //  - ممیزی v1.1.4: کاربر عمومی داخل «ترِیال شخصی دقیقاً ۲۴ ساعته» خودش از قفل نصب عبور می‌کند
  //    (شروع ترِیال وابسته به زمان ثبت‌نام است، نه زمان ثبت‌نام دیگران یا نصب)
  if (!(await isLicenseValid())) {
    const phase = await licenseLockPhase();
    const staffTrialExempt = !ctx.isAdmin && ctx.user.kind === "STAFF" && phase === "TRIAL_OVER";
    const personalTrialActive =
      !ctx.isAdmin &&
      ctx.user.kind === "PUBLIC" &&
      !!ctx.trialUntil &&
      new Date(ctx.trialUntil).getTime() > Date.now();
    if (!staffTrialExempt && !personalTrialActive) return { error: await licenseLockedResponseDetailed() };
  }
  if (section && !ctx.isAdmin && !ctx.sections.includes(section)) {
    return { error: forbidden(`دسترسی به بخش «${section}» برای شما فعال نیست یا منقضی شده است`) };
  }
  return { ctx };
}

/**
 * آیا «این کاربر» با قفل لایسنس مواجه است؟ — برای /api/auth/me و تصمیم UI
 * همان سیاست requireAuth: مالک آزاد؛ ترِیال شخصی فعال کاربر عمومی آزاد؛
 * پرسنل فقط از قفل ترِیال معاف؛ بقیه در قفل (مهلت/پس از مهلت)
 */
export async function isUserLicenseLocked(ctx: AuthContext): Promise<boolean> {
  if (await isLicenseValid()) return false;
  if (
    !ctx.isAdmin &&
    ctx.user.kind === "PUBLIC" &&
    !!ctx.trialUntil &&
    new Date(ctx.trialUntil).getTime() > Date.now()
  )
    return false;
  const phase = await licenseLockPhase();
  if (!ctx.isAdmin && ctx.user.kind === "STAFF" && phase === "TRIAL_OVER") return false;
  return true;
}
