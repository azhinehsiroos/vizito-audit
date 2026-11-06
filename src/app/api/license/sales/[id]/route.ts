import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { requireOwnerContext, adminAccessLogData, logSaAccess } from "@/lib/sa";
import { strOrNull } from "@/lib/validate";

type Params = { params: Promise<{ id: string }> };

// M9: گارد یکپارچه مالک — منبع واحد در sa.ts

/** انقضای مؤثر یک فروش — رکورد ثبت‌شده یا محاسبه از تاریخ صدور؛ دائمی (۰) = بدون انقضا */
function effectiveExpiry(sale: {
  expiresAt: Date | null;
  createdAt: Date;
  durationDays: number;
}): Date | null {
  if (sale.durationDays === 0) return null; // دائمی
  return sale.expiresAt ?? new Date(sale.createdAt.getTime() + sale.durationDays * 86_400_000);
}

/** پروفایل خریدار لایسنس + تاریخچه شارژ — فقط سازنده برنامه */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const denied = requireOwnerContext(auth.ctx);
  if (denied) return denied;
  try {
    const { id } = await params;
    const sale = await db.licenseSale.findUnique({
      where: { id },
      include: { charges: { orderBy: { createdAt: "desc" }, take: 50 } },
    });
    if (!sale) return Response.json({ error: "فروش لایسنس یافت نشد" }, { status: 404 });
    // M3: مشاهده پروفایل خریدار — حسابرسی fail-closed
    await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, null, "VIEW_LICENSE_SALE", req, `sale=${id.slice(0, 12)}`);
    const eff = effectiveExpiry(sale);
    return Response.json({
      sale: {
        ...sale,
        expiresAt: eff ? eff.toISOString() : null,
        daysLeft: eff ? Math.ceil((eff.getTime() - Date.now()) / 86_400_000) : null,
        permanent: sale.durationDays === 0,
      },
    });
  } catch (e) {
    console.error("license sale detail error", e);
    return Response.json({ error: "خطا در دریافت فروش لایسنس" }, { status: 500 });
  }
}

/**
 * مدیریت فروش لایسنس توسط سازنده:
 *  - { addDays } — شارژ مجدد/تمدید (تمدید زودهنگام از انقضای فعلی شمرده می‌شود — اعتبار نمی‌سوزد)
 *  - { pauseDeletion: true|false } — توقف/ادامه حذف خودکار پس از مهلت ۳۰ روزه
 * لایسنس دائمی نیازی به شارژ ندارد.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const denied = requireOwnerContext(auth.ctx);
  if (denied) return denied;
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const sale = await db.licenseSale.findUnique({ where: { id } });
    if (!sale) return Response.json({ error: "فروش لایسنس یافت نشد" }, { status: 404 });

    // ── توقف/ادامه حذف خودکار (مهلت ۳۰ روزه) — مستقل از شارژ ──
    if (typeof body.pauseDeletion === "boolean") {
      // M3: تغییر وضعیت حذف خودکار — حسابرسی تراکنشی (fail-closed)
      const updated = await db.$transaction(async (tx) => {
        const u = await tx.licenseSale.update({
          where: { id },
          data: { pauseDeletion: body.pauseDeletion as boolean },
        });
        await tx.adminAccessLog.create({
          data: adminAccessLogData(auth.ctx.user.id, auth.ctx.user.name, null, "LICENSE_SALE_PAUSE_DELETION", req, String(body.pauseDeletion)),
        });
        return u;
      });
      const eff = effectiveExpiry(updated);
      return Response.json({
        sale: {
          ...updated,
          expiresAt: eff ? eff.toISOString() : null,
          daysLeft: eff ? Math.ceil((eff.getTime() - Date.now()) / 86_400_000) : null,
          permanent: updated.durationDays === 0,
        },
      });
    }

    const addDays = Math.round(Number(body.addDays));
    const note = strOrNull(body.note, 300);
    if (sale.durationDays === 0) {
      return Response.json({ error: "لایسنس دائمی نیازی به شارژ ندارد" }, { status: 400 });
    }
    if (!Number.isFinite(addDays) || addDays < 1 || addDays > 3650) {
      return Response.json({ error: "مدت شارژ باید بین ۱ تا ۳۶۵۰ روز باشد" }, { status: 400 });
    }
    // تمدید از انقضای مؤثر فعلی — اگر منقضی شده، از امروز شمرده می‌شود (اعتبار باقی‌مانده حفظ می‌شود)
    const current = effectiveExpiry(sale);
    const base = Math.max(current ? current.getTime() : 0, Date.now());
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
      // M3: شارژ مجدد/تمدید — حسابرسی درون همان تراکنش (fail-closed)
      db.adminAccessLog.create({
        data: adminAccessLogData(auth.ctx.user.id, auth.ctx.user.name, null, "LICENSE_SALE_RECHARGE", req, `+${addDays}d`),
      }),
    ]);
    return Response.json({
      sale: {
        ...updated,
        expiresAt: expiresAt.toISOString(),
        daysLeft: Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000),
        permanent: false,
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
  const denied = requireOwnerContext(auth.ctx);
  if (denied) return denied;
  const { id } = await params;
  try {
    const sale = await db.licenseSale.findUnique({ where: { id } });
    if (!sale) return Response.json({ error: "فروش لایسنس یافت نشد" }, { status: 404 });
    // ممیزی v1.1.4 — ردپای حسابرسی حذف فروش: سوابق صدور/تمدید نباید بدون رد کنار بروند؛
    // لاگ پیوست‌شونده در Setting (بدون migration) — سقف ۱۰۰ رکورد آخر
    const logKey = "license_sales_deleted_log";
    const prev = await db.setting.findUnique({ where: { key: logKey } });
    let entries: unknown[] = [];
    if (prev) {
      try {
        const parsed: unknown = JSON.parse(prev.value);
        if (Array.isArray(parsed)) entries = parsed;
      } catch {
        entries = [];
      }
    }
    entries.push({
      id: sale.id,
      buyer: `${sale.buyerName} — ${sale.buyerMobile}`,
      duration: sale.durationLabel,
      durationDays: sale.durationDays,
      issuedAt: sale.createdAt.toISOString(),
      expiresAt: sale.expiresAt ? sale.expiresAt.toISOString() : null,
      deletedAt: new Date().toISOString(),
      deletedBy: auth.ctx.user.mobile,
    });
    if (entries.length > 100) entries = entries.slice(-100);
    // M3: حذف فروش — رد حسابرسی + حذف در یک تراکنش (fail-closed)
    await db.$transaction(async (tx) => {
      await tx.setting.upsert({
        where: { key: logKey },
        update: { value: JSON.stringify(entries) },
        create: { key: logKey, value: JSON.stringify(entries) },
      });
      await tx.licenseSale.delete({ where: { id } });
      await tx.adminAccessLog.create({
        data: adminAccessLogData(auth.ctx.user.id, auth.ctx.user.name, null, "LICENSE_SALE_DELETE", req, `sale=${id.slice(0, 12)}`),
      });
    });
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
