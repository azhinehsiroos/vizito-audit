import { db } from "@/lib/db";

/**
 * بوت‌استرپ «مجموعه من» سازنده — فاز D (مرحله ۲ دستور تجاری)
 * -----------------------------------------------------------------------------
 * سازنده برنامه (SUPER_ADMIN) علاوه بر «مدیریت کل»، یک مجموعه واقعی و مستقل
 * دارد تا خودش هم بتواند اپ را برای مجموعه خودش (آژیوان) استفاده کند:
 *  - مجموعه‌ای یکتا با نام VIZITO_VENDOR_ORG_NAME (پیش‌فرض «آژیوان سروش»)
 *  - لایسنس دائمی (PERM — expiresAt=null) با source=VENDOR
 *  - اتصال حساب سازنده به همین مجموعه (User.orgId)
 *
 * تضمین‌ها:
 *  - Idempotent: با کلید یکتای Setting «vendor_org_id» هیچ‌گاه مجموعه دوم
 *    ساخته نمی‌شود؛ همه سازنده‌ها (OWNER_MOBILES) به «همان یک» مجموعه می‌پیوندند.
 *  - اتمیک: ساخت مجموعه + لایسنس + رویداد لایسنس + حسابرسی + اتصال کاربر در
 *    «یک تراکنش» انجام می‌شود (هم‌تراز سیاست M2).
 *  - بدون قفل‌کردن /me: هر خطا فقط لاگ می‌شود و null برمی‌گردد — فراخوانی
 *    بعدیِ /me دوباره تلاش می‌کند (بوت‌استرپ اختیاریِ خودترمیم است).
 *  - سازندهِ دارای مجموعه (مسیر ارتقا با حفظ orgId) فقط در «نبودِ» لایسنس
 *    لایسنس PERM می‌گیرد — لایسنس موجود (حتی SUSPENDED) دست‌نخورده می‌ماند
 *    تا بوت‌استرپ هرگز تعلیق عمدی را بی‌اثر نکند.
 *  - سازنده شخصاً از قفل لایسنس معاف است (auth.ts)؛ لایسنس PERM برای «پرسنل
 *    آینده» مجموعه سازنده و نمایش وضعیت صحیح در UI است.
 */

const VENDOR_ORG_KEY = "vendor_org_id";
const DEFAULT_VENDOR_ORG_NAME = "آژیوان سروش";

export function vendorOrgName(): string {
  const raw = (process.env.VIZITO_VENDOR_ORG_NAME || "").trim();
  return ((raw || DEFAULT_VENDOR_ORG_NAME).slice(0, 80)) || DEFAULT_VENDOR_ORG_NAME;
}

export type VendorOrgResult = {
  orgId: string;
  orgName: string;
  created: boolean; // مجموعه تازه ساخته شد
  linked: boolean; // orgId کاربر تغییر کرد (اتصال/تغییر اتصال)
  permEnsured: boolean; // لایسنس PERM تازه ساخته شد
  /** اگر true، فراخواننده باید نشست/ctx را دوباره بخواند */
  changed: boolean;
};

/** قفل درون‌پردازشی — دو /me هم‌زمان نباید وارد مسیر ساخت شوند (Setting یکتا پشتیبان DB است) */
let chain: Promise<unknown> = Promise.resolve();
function withVendorLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

type VendorUserRow = { id: string; name: string; role: string; orgId: string | null };

async function loadVendorUser(userId: string): Promise<VendorUserRow | null> {
  const u = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, role: true, orgId: true },
  });
  return u && u.role === "SUPER_ADMIN" ? u : null;
}

/** رکورد مجموعه سازنده از نشانهٔ Setting — برای ابزارهای مدیریتی/تست */
export async function getVendorOrg(): Promise<{ id: string; name: string } | null> {
  const marker = await db.setting.findUnique({ where: { key: VENDOR_ORG_KEY } });
  if (!marker?.value) return null;
  return db.org.findUnique({ where: { id: marker.value }, select: { id: true, name: true } });
}

/**
 * تضمین idempotent وضعیت «مجموعه من» برای حساب سازنده:
 *  ۱) سازنده بدون مجموعه → مجموعه سازنده (یکتا) + لایسنس PERM + اتصال
 *  ۲) سازنده دارای مجموعه ولی بدون لایسنس → فقط لایسنس PERM (مجموعه دست‌نخورده)
 *  ۳) سازنده دارای مجموعه دارای لایسنس → بدون هیچ تغییری (changed=false)
 */
export async function ensureVendorOrg(userId: string): Promise<VendorOrgResult | null> {
  try {
    const user = await loadVendorUser(userId);
    if (!user) return null;

    // حالت ۳ — سریع‌ترین مسیر (سازنده مجموعه + لایسنس دارد)
    if (user.orgId) {
      const org = await db.org.findUnique({
        where: { id: user.orgId },
        select: { id: true, name: true },
      });
      if (org) {
        const license = await db.license.findUnique({ where: { orgId: org.id }, select: { id: true } });
        if (license) {
          return { orgId: org.id, orgName: org.name, created: false, linked: false, permEnsured: false, changed: false };
        }
      }
    }

    return withVendorLock(async () => {
      // بازخوانی پس از کسب قفل (ضد رقابت دو /me هم‌زمان)
      const fresh = await loadVendorUser(userId);
      if (!fresh) return null;

      // مجموعه موجود سازنده: اول نشانهٔ Setting، بعد orgId تازهٔ کاربر — هیچ‌گاه دومی نمی‌سازیم
      const marker = await db.setting.findUnique({ where: { key: VENDOR_ORG_KEY } });
      let org = marker?.value
        ? await db.org.findUnique({ where: { id: marker.value }, select: { id: true, name: true } })
        : null;
      if (!org && fresh.orgId) {
        org = await db.org.findUnique({ where: { id: fresh.orgId }, select: { id: true, name: true } });
      }

      let created = false;
      let linked = false;
      let permEnsured = false;

      const result = await db.$transaction(async (tx) => {
        const target = org ?? (await tx.org.create({ data: { name: vendorOrgName() }, select: { id: true, name: true } }));
        created = !org;

        const existingLicense = await tx.license.findUnique({ where: { orgId: target.id }, select: { id: true } });
        if (!existingLicense) {
          await tx.license.create({
            data: {
              orgId: target.id,
              plan: "PERM",
              status: "ACTIVE",
              source: "VENDOR",
              expiresAt: null, // PERM — دائمی
              note: "لایسنس دائمی «مجموعه من» سازنده — بوت‌استرپ خودکار (فاز D، مرحله ۲ دستور تجاری)",
            },
          });
          await tx.licenseEvent.create({
            data: {
              orgId: target.id,
              type: "ISSUE",
              plan: "PERM",
              actorName: fresh.name,
              note: "بوت‌استرپ «مجموعه من» سازنده",
            },
          });
          permEnsured = true;
        }

        if (fresh.orgId !== target.id) {
          await tx.user.update({ where: { id: fresh.id }, data: { orgId: target.id } });
          linked = true;
        }

        await tx.setting.upsert({
          where: { key: VENDOR_ORG_KEY },
          update: { value: target.id },
          create: { key: VENDOR_ORG_KEY, value: target.id },
        });

        await tx.adminAccessLog.create({
          data: {
            actorId: fresh.id,
            actorName: fresh.name,
            orgId: target.id,
            action: created ? "VENDOR_ORG_BOOTSTRAP" : "VENDOR_ORG_LINK",
            detail: created
              ? `مجموعه «${target.name}» با لایسنس PERM ساخته و به سازنده متصل شد`
              : linked
                ? `سازنده به «مجموعه من» (${target.name}) متصل شد`
                : `لایسنس PERM «مجموعه من» (${target.name}) تضمین شد`,
          },
        });

        return {
          orgId: target.id,
          orgName: target.name,
          created,
          linked,
          permEnsured,
          changed: created || linked || permEnsured,
        } satisfies VendorOrgResult;
      });
      return result;
    });
  } catch (e) {
    // بوت‌استرپ هرگز /me را نمی‌شکند — فراخوانی بعدی دوباره تلاش می‌کند
    console.error("vendor-org bootstrap error", (e as Error)?.name || "unknown");
    return null;
  }
}
