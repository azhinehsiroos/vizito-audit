import crypto from "crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  hashPassword,
  newToken,
  tooMany,
  passwordError,
  sessionCookie,
  FIRST_ADMIN_CLAIM_KEY,
  jsonContentTypeGate,
} from "@/lib/auth";
import {
  dbRateLimit,
  dbRetryAfterSeconds,
  getClientIp,
} from "@/lib/rate-limit";
import { isLicenseValid, licenseLockedResponse, isOwnerMobile, startTrial } from "@/lib/license";
import { normalizeMobile, MOBILE_RE, strField } from "@/lib/validate";

const INVITE_KEY = "invite_code";

/** مقایسه امن در برابر timing attack */
function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** خطای داخلی تراکنش ثبت‌نام — پاسخ نهایی را حمل می‌کند */
class RegisterAbort extends Error {
  constructor(public response: Response) {
    super("register-abort");
  }
}

/**
 * قفل درون‌پردازشی ثبت‌نام — تراکنش‌های ثبت‌نام را سری می‌کند تا هرگز
 * روی SQLite رقابت نوشتن/timeout (P1008) رخ ندهد.
 * (برای چند نمونه سرور، ردیف «رزرو اولین مدیر» همان تضمین را در سطح دیتابیس می‌دهد)
 */
let registerQueue: Promise<unknown> = Promise.resolve();
function withRegisterLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = registerQueue.then(fn, fn);
  registerQueue = run.catch(() => {});
  return run;
}

const DUPLICATE_RESPONSE = () =>
  // پاسخ عمومی برای شماره تکراری — افشای وجود/نبودن حساب را نمی‌دهد
  Response.json(
    { error: "ثبت‌نام انجام نشد — اگر قبلاً با این شماره ثبت‌نام کرده‌اید از «ورود» استفاده کنید" },
    { status: 409 }
  );

export async function POST(req: NextRequest) {
  // ── ضد CSRF (مسیر عمومی) — فقط application/json؛ اپ خود برنامه همین را می‌فرستد ──
  const csrf = jsonContentTypeGate(req);
  if (csrf) return csrf;

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const mobile = normalizeMobile(body.mobile);
    const name = strField(body.name, 80);
    const company = strField(body.company, 80) || null;
    const password = typeof body.password === "string" ? body.password : "";
    const inviteCode = strField(body.inviteCode, 40);

    // ── ۱) محدودیت نرخ «قبل از هر عملیات پرهزینه» (هش رمز/چک کلید/دیتابیس) ──
    // دیتابیسی: حداکثر ۵ ثبت‌نام در ساعت از هر IP و ۳ بار در ۱۰ دقیقه برای هر شماره
    const ip = getClientIp(req);
    if (!(await dbRateLimit(`reg-ip:${ip}`, 5, 60 * 60 * 1000))) {
      return tooMany(await dbRetryAfterSeconds(`reg-ip:${ip}`));
    }
    if (!MOBILE_RE.test(mobile)) {
      return Response.json({ error: "شماره موبایل باید ۱۱ رقم و با ۰۹ شروع شود" }, { status: 400 });
    }
    if (!(await dbRateLimit(`reg-m:${mobile}`, 3, 10 * 60 * 1000))) {
      return tooMany(await dbRetryAfterSeconds(`reg-m:${mobile}`));
    }

    // ── ۲) مسیر سازنده — چک کلید «قبل از» هش رمز (هش پرهزینه است) ──
    // ثبت‌نام با شماره سازنده فقط با «کلید راه‌اندازی سازنده» ممکن است
    // (env: OWNER_SETUP_KEY — فقط روی سرور سازنده تنظیم می‌شود)
    // سقف سخت‌گیرانه جداگانه: ۵ بار در ساعت از هر IP
    let ownerSetupOk = false;
    if (isOwnerMobile(mobile)) {
      if (!(await dbRateLimit(`owner-setup:${ip}`, 5, 60 * 60 * 1000))) {
        return tooMany(await dbRetryAfterSeconds(`owner-setup:${ip}`));
      }
      const setupKey = typeof body.setupKey === "string" ? body.setupKey.trim() : "";
      const expected = process.env.OWNER_SETUP_KEY || "";
      const provided = setupKey.length > 0;
      const expectedSet = expected.length > 0;
      const match = expectedSet && provided && safeEq(setupKey, expected);
      // ⚠️ عیب‌یابی موقت (خطای OWNER_KEY_REQUIRED روی هاست) — فقط وضعیت بولی،
      // هرگز مقدار کلید/رمز/توکن لاگ نمی‌شود. پس از تشخیص، این بلاک حذف شود.
      console.error(
        "register owner-key diag:",
        JSON.stringify({ ownerMobile: true, expectedSet, provided, match })
      );
      if (!match) {
        return Response.json(
          { error: "این شماره فقط با «کلید راه‌اندازی سازنده» قابل ثبت‌نام است", code: "OWNER_KEY_REQUIRED" },
          { status: 403 }
        );
      }
      ownerSetupOk = true;
    }

    // ── ۳) اعتبارسنجی‌های ارزان — بعد از محدودیت نرخ ──
    if (!name) {
      return Response.json({ error: "نام و نام شرکت الزامی است" }, { status: 400 });
    }
    const pwdErr = passwordError(password);
    if (pwdErr) {
      return Response.json({ error: pwdErr }, { status: 400 });
    }

    // ── ۴) هش رمز (پرهزینه‌ترین عملیات) — «بعد از» محدودیت نرخ و چک کلید ──
    const passwordHash = await hashPassword(password);

    /* -------------------------------------------------------------------------
     * ثبت‌نام اتمیک — ضد رقابت هم‌زمان (رکورد اول = مدیر)
     * مشکل قدیمی: دو درخواست هم‌زمان هر دو «نصب خالی» را می‌دیدند و هر دو مدیر می‌شدند.
     * راه‌حل: کل مسیر «شمارش + تعیین نقش + ساخت کاربر» داخل یک تراکنش است و نقش مدیر
     * فقط به کسی می‌رسد که بتواند ردیف «رزرو اولین مدیر» (key یکتا در Setting) را بسازد.
     * ساخت ردیف یکتا در سطح دیتابیس اتمیک است ⇒ فقط یک درخواست برنده می‌شود؛
     * بقیه به مسیر عادی (لایسنس + کد دعوت) هدایت می‌شوند.
     *
     * سیاست سازنده: ثبت‌نام معتبر سازنده (شماره ∈ OWNER_MOBILES + کلید درست)
     * «همیشه» به حساب ADMIN منجر می‌شود — حتی اگر قبلاً کاربری با همان شماره
     * وجود داشته باشد (ارتقای اتمیک USER→ADMIN + بازنشانی رمز + ابطال نشست‌ها).
     * این مسیر هیچ راه ارتقایی برای کاربران عادی نمی‌سازد: هم شماره باید در
     * OWNER_MOBILES سمت سرور باشد و هم کلید راه‌اندازی درست باشد.
     * ---------------------------------------------------------------------- */
    const result = await withRegisterLock(() =>
      db.$transaction(async (tx) => {
      const exists = await tx.user.findUnique({ where: { mobile } });

      // سازنده با کلید معتبر: ارتقای اتمیک حساب موجود به ADMIN (حتی اگر USER بود)
      if (exists && ownerSetupOk) {
        const updated = await tx.user.update({
          where: { id: exists.id },
          data: { role: "ADMIN", name, company, password: passwordHash },
        });
        // امنیت: رمز عوض شد ⇒ همه نشست‌های قبلی این حساب ابطال شود
        await tx.authSession.deleteMany({ where: { userId: exists.id } });
        return { user: updated, isFirst: false, upgraded: true };
      }

      // غیرِ سازنده: شماره تکراری مطلقاً ثبت نمی‌شود (جلوگیری از ثبت‌نام تکراری)
      if (exists) throw new RegisterAbort(DUPLICATE_RESPONSE());

      const userCount = await tx.user.count();
      let isFirst = userCount === 0;

      // اولین ثبت‌نام (غیرِ سازنده) فقط با «کد راه‌اندازی اولیه» (env: SETUP_TOKEN) ممکن است
      if (isFirst && !ownerSetupOk) {
        const expected = process.env.SETUP_TOKEN || "";
        const given = typeof body.setupToken === "string" ? body.setupToken.trim() : "";
        if (!expected || !safeEq(given, expected)) {
          throw new RegisterAbort(
            Response.json(
              { error: "کد راه‌اندازی اولیه نادرست است", code: "SETUP_TOKEN_REQUIRED" },
              { status: 403 }
            )
          );
        }
      }

      // رزرو اتمیک نقش «اولین مدیر» — در حالت هم‌زمانی فقط یک درخواست موفق می‌شود
      if (isFirst) {
        try {
          await tx.setting.create({
            data: { key: FIRST_ADMIN_CLAIM_KEY, value: "1" },
          });
        } catch (e) {
          if ((e as { code?: string }).code === "P2002") {
            // درخواست دیگری در همین لحظه مدیر اول شده — این درخواست مسیر عادی می‌رود
            isFirst = false;
          } else {
            throw e;
          }
        }
      }

      // قفل لایسنس — سازنده همیشه مستثنا؛ مدیر اول (با SETUP_TOKEN معتبر) بدون لایسنس هم
      // می‌تواند مدیر شود و تریال ۲۴ ساعته می‌گیرد؛ بقیه فقط با لایسنس معتبر.
      if (!isFirst && !ownerSetupOk && !(await isLicenseValid())) {
        throw new RegisterAbort(licenseLockedResponse());
      }

      // ثبت‌نام‌های بعدی فقط با کد دعوت مدیر — استثنا: سازنده با کلید راه‌اندازی معتبر
      if (!isFirst && !ownerSetupOk) {
        const invite = await tx.setting.findUnique({ where: { key: INVITE_KEY } });
        if (!invite || !inviteCode || inviteCode !== invite.value) {
          throw new RegisterAbort(
            Response.json(
              { error: "ثبت‌نام فقط با کد دعوت مدیر امکان‌پذیر است" },
              { status: 403 }
            )
          );
        }
      }

      const user = await tx.user.create({
        data: {
          mobile,
          name,
          company,
          password: passwordHash,
          // نقش: اولین کاربر = مدیر؛ سازنده با کلید معتبر = «همیشه» مدیر؛ بقیه = کاربر عادی
          role: isFirst || ownerSetupOk ? "ADMIN" : "USER",
        },
      });
      return { user, isFirst, upgraded: false };
      })
    );

    const { user, isFirst, upgraded } = result;

    // ثبت‌نام اولین کاربر روی نصب تازه → دوره آزمایشی ۲۴ ساعته خودکار (پس از آن صفحه خرید لایسنس)
    if (isFirst && !ownerSetupOk && !(await isLicenseValid())) {
      await startTrial(24);
    }

    const token = await newToken(user.id, user.role, req.headers.get("user-agent"));
    // امنیت: توکن در کوکی HttpOnly ست می‌شود — فیلد token فقط برای سازگاری اپ قدیمی
    return Response.json(
      {
        token,
        upgraded,
        user: { id: user.id, mobile: user.mobile, name: user.name, role: user.role },
      },
      { headers: { "Set-Cookie": sessionCookie(req, token) } }
    );
  } catch (e) {
    if (e instanceof RegisterAbort) return e.response;
    // ضد race: اگر بین بررسی و ساخت، ثبت‌نام دیگری با همان شماره انجام شده باشد
    if ((e as { code?: string }).code === "P2002") return DUPLICATE_RESPONSE();
    console.error("register error", e);
    return Response.json({ error: "خطای سرور در ثبت‌نام" }, { status: 500 });
  }
}
