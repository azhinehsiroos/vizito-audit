import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden, getAuth } from "@/lib/auth";
import { isOwnerMobile } from "@/lib/license";
import { isSafeImageDataUrl } from "@/lib/validate";

const LOGO_KEY = "app_logo";
const INVITE_KEY = "invite_code";
const MAX_LOGO_LEN = 1_500_000; // ~1.5MB data URL

/** دریافت تنظیمات برند — لوگو عمومی؛ کد دعوت فقط برای سازنده (M8 — اصلاح فاز B) */
export async function GET(req: NextRequest) {
  const rows = await db.setting.findMany({
    where: { key: { in: [LOGO_KEY, INVITE_KEY] } },
  });
  const logo = rows.find((r) => r.key === LOGO_KEY)?.value || null;

  // M8: کد دعوت یک Setting سراسریِ vendor است — هرگز به مدیران مجموعه‌ها نمایش داده نمی‌شود
  const ctx = await getAuth(req);
  const isVendor = !!ctx && ctx.isAdmin && (ctx.isSuperAdmin || isOwnerMobile(ctx.user.mobile));
  const inviteCode = isVendor ? rows.find((r) => r.key === INVITE_KEY)?.value || null : undefined;

  return Response.json(inviteCode === undefined ? { logo } : { logo, inviteCode });
}

/** تغییر لوگو / تنظیمات برند — فقط مدیر (برندینگ نصب — داده تجاری سازمانی نیست، بدون section) */
export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) return forbidden("فقط مدیر می‌تواند لوگو را تغییر دهد");
  try {
    const body = (await req.json().catch(() => ({}))) as { logo?: string | null };
    if (body.logo === null) {
      await db.setting.deleteMany({ where: { key: LOGO_KEY } });
      return Response.json({ logo: null });
    }
    const logo = typeof body.logo === "string" ? body.logo.trim() : "";
    if (!logo) return Response.json({ error: "تصویر لوگو ارسال نشده است" }, { status: 400 });
    if (!isSafeImageDataUrl(logo)) {
      return Response.json({ error: "فرمت لوگو باید تصویر (PNG/JPEG/WEBP) باشد" }, { status: 400 });
    }
    if (logo.length > MAX_LOGO_LEN) {
      return Response.json({ error: "حجم تصویر لوگو بیش از حد بزرگ است" }, { status: 400 });
    }
    await db.setting.upsert({
      where: { key: LOGO_KEY },
      update: { value: logo },
      create: { key: LOGO_KEY, value: logo },
    });
    return Response.json({ logo });
  } catch (e) {
    console.error("settings error", e);
    return Response.json({ error: "خطا در ذخیره تنظیمات" }, { status: 500 });
  }
}
