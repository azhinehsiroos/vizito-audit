import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden } from "@/lib/auth";
import { isOwnerMobile } from "@/lib/license";
import { strOrNull } from "@/lib/validate";

type Params = { params: Promise<{ id: string }> };

function guardOwner(ctxMobile: string, isAdmin: boolean): Response | null {
  if (!isAdmin || !isOwnerMobile(ctxMobile)) {
    return forbidden("این بخش فقط برای سازنده برنامه فعال است");
  }
  return null;
}

/** انقضای مؤثر یک فروش — رکورد ثبت‌شده یا محاسبه از تاریخ صدور */
function effectiveExpiry(sale: { expiresAt: Date | null; createdAt: Date; durationDays: number }): Date {
  return sale.expiresAt ?? new Date(sale.createdAt.getTime() + sale.durationDays * 86_400_000);
}

/** پروفایل خریدار لایسنس + تاریخچه شارژ — فقط سازنده برنامه */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const denied = guardOwner(auth.ctx.user.mobile, auth.ctx.isAdmin);
  if (denied) return denied;
  const { id } = await params;
  const sale = await db.licenseSale.findUnique({
    where: { id },
    include: { charges: { orderBy: { createdAt: "desc" }, take: 50 } },
  });
  if (!sale) return Response.json({ error: "فروش لایسنس یافت نشد" }, { status: 404 });
  const eff = effectiveExpiry(sale);
  return Response.json({
    sale: {
      ...sale,
      expiresAt: eff.toISOString(),
      daysLeft: Math.ceil((eff.getTime() - Date.now()) / 86_400_000),
    },
  });
}

/**
 * شارژ مجدد / تمدید لایسنس خریدار — فقط سازنده برنامه
 * همان کلید قبلی معتبر می‌ماند؛ فقط انقضای مؤثر تمدید می‌شود (بدون کلید جدید)
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const denied = guardOwner(auth.ctx.user.mobile, auth.ctx.isAdmin);
  if (denied) return denied;
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const addDays = Math.round(Number(body.addDays));
    const note = strOrNull(body.note, 300);
    if (!Number.isFinite(addDays) || addDays < 1 || addDays > 3650) {
      return Response.json({ error: "مدت شارژ باید بین ۱ تا ۳۶۵۰ روز باشد" }, { status: 400 });
    }
    const sale = await db.licenseSale.findUnique({ where: { id } });
    if (!sale) return Response.json({ error: "فروش لایسنس یافت نشد" }, { status: 404 });
    // تمدید از انقضای مؤثر فعلی — اگر منقضی شده، از امروز شمرده می‌شود
    const current = effectiveExpiry(sale);
    const base = Math.max(current.getTime(), Date.now());
    const expiresAt = new Date(base + addDays * 86_400_000);
    const [updated] = await db.$transaction([
      db.licenseSale.update({ where: { id }, data: { expiresAt } }),
      db.licenseCharge.create({
        data: {
          saleId: id,
          addDays,
          note,
          createdByName: auth.ctx.user.name,
        },
      }),
    ]);
    return Response.json({
      sale: {
        ...updated,
        expiresAt: expiresAt.toISOString(),
        daysLeft: Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000),
      },
    });
  } catch (e) {
    console.error("license sale recharge error", e);
    return Response.json({ error: "خطا در شارژ مجدد لایسنس" }, { status: 500 });
  }
}

/** حذف فروش لایسنس — فقط سازنده برنامه (اگر همین کلید روی سرور فعال باشد، لایسنس هم باطل می‌شود) */
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const denied = guardOwner(auth.ctx.user.mobile, auth.ctx.isAdmin);
  if (denied) return denied;
  const { id } = await params;
  try {
    const sale = await db.licenseSale.findUnique({ where: { id } });
    if (!sale) return Response.json({ error: "فروش لایسنس یافت نشد" }, { status: 404 });
    await db.licenseSale.delete({ where: { id } });
    // اگر کلیدِ همین فروش روی این سرور فعال باشد، با حذف فروش لایسنس هم باطل می‌شود
    const row = await db.setting.findUnique({ where: { key: "license_v1" } });
    if (row && row.value.includes(`"${sale.key}"`)) {
      await db.setting.delete({ where: { key: "license_v1" } }).catch(() => {});
    }
    return Response.json({ ok: true });
  } catch (e) {
    console.error("license sale delete error", e);
    return Response.json({ error: "خطا در حذف فروش لایسنس" }, { status: 500 });
  }
}
