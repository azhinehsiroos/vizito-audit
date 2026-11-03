import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden } from "@/lib/auth";
import { isOwnerMobile, makeLicenseKey } from "@/lib/license";
import { strField, strOrNull } from "@/lib/validate";

const DURATIONS = [
  { days: 30, label: "۱ ماهه" },
  { days: 90, label: "۳ ماهه" },
  { days: 180, label: "۶ ماهه" },
  { days: 365, label: "۱ ساله" },
];

function labelFor(days: number): string {
  return DURATIONS.find((d) => d.days === days)?.label || `${days} روزه`;
}

function guardOwner(ctxMobile: string, isAdmin: boolean): Response | null {
  if (!isAdmin || !isOwnerMobile(ctxMobile)) {
    return forbidden("این بخش فقط برای سازنده برنامه فعال است");
  }
  return null;
}

/** دفتر فروش لایسنس — فقط سازنده برنامه */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const denied = guardOwner(auth.ctx.user.mobile, auth.ctx.isAdmin);
  if (denied) return denied;
  const sales = await db.licenseSale.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  const now = Date.now();
  return Response.json({
    sales: sales.map((s) => {
      // انقضای مؤثر: رکورد ثبت‌شده (قابل تمدید با شارژ مجدد) یا محاسبه از تاریخ صدور
      const eff = s.expiresAt ?? new Date(s.createdAt.getTime() + s.durationDays * 86_400_000);
      return {
        ...s,
        expiresAt: eff.toISOString(),
        daysLeft: Math.ceil((eff.getTime() - now) / 86_400_000),
      };
    }),
  });
}

/** صدور لایسنس جدید برای خریدار — فقط سازنده برنامه */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const denied = guardOwner(auth.ctx.user.mobile, auth.ctx.isAdmin);
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const buyerName = strField(body.buyerName, 80);
    const buyerMobile = strField(body.buyerMobile, 20);
    const durationDays = Math.round(Number(body.durationDays));
    const price = strOrNull(body.price, 40);
    const note = strOrNull(body.note, 300);
    const installId = strOrNull(body.installId, 40);
    if (!buyerName) return Response.json({ error: "نام خریدار الزامی است" }, { status: 400 });
    if (!buyerMobile) return Response.json({ error: "موبایل خریدار الزامی است" }, { status: 400 });
    if (!Number.isFinite(durationDays) || durationDays < 1 || durationDays > 3650) {
      return Response.json({ error: "مدت لایسنس نامعتبر است" }, { status: 400 });
    }
    // امنیت: کلید بدون installId روی هر سروری کار می‌کند — صدورش ممنوع است
    if (!installId) {
      return Response.json(
        { error: "شناسه نصب (installId) الزامی است — از صفحه لایسنسِ مشتری یا تنظیمات سرور مقصد بگیرید" },
        { status: 400 }
      );
    }
    // صدور کلید VZT2 با امضای نامتقارن — فقط روی سروری که کلید خصوصی دارد (سرور سازنده)
    let key: string;
    try {
      key = makeLicenseKey(buyerName, buyerMobile, new Date(Date.now() + durationDays * 86_400_000), installId);
    } catch {
      return Response.json(
        { error: "صدور کلید روی این سرور فعال نیست — از اسکریپت license:gen روی سیستم سازنده استفاده کنید (شارژ مجدد خریداران موجود کار می‌کند)" },
        { status: 400 }
      );
    }
    const expiresAt = new Date(Date.now() + durationDays * 86_400_000);
    const sale = await db.licenseSale.create({
      data: { buyerName, buyerMobile, durationDays, durationLabel: labelFor(durationDays), key, price, note, expiresAt },
    });
    return Response.json(
      {
        sale: {
          ...sale,
          expiresAt: (sale.expiresAt ?? expiresAt).toISOString(),
          daysLeft: Math.ceil(((sale.expiresAt ?? expiresAt).getTime() - Date.now()) / 86_400_000),
        },
      },
      { status: 201 }
    );
  } catch (e) {
    console.error("license sale create error", e);
    return Response.json({ error: "خطا در صدور لایسنس" }, { status: 500 });
  }
}
