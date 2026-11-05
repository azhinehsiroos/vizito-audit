import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSuper, logSaAccess } from "@/lib/sa";
import { strField } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * لاگ دسترسی سازنده به داده مجموعه‌ها (AdminAccessLog) — فقط سازنده
 * -----------------------------------------------------------------------------
 * GET ?orgId=&action=&actorId=&q=&page=&pageSize=
 *  - فهرست نزولی بر اساس زمان + صفحه‌بندی (سقف ۱۰۰ ردیف در صفحه)
 *  - هر فراخوانی خودش هم به‌صورت VIEW_ACCESS_LOGS ثبت می‌شود (شفافیت کامل)
 *  - هیچ ردیفی از این مسیر حذف یا ویرایش نمی‌شود (دفتر حسابرسی append-only)
 */

export async function GET(req: NextRequest) {
  const auth = await requireSuper(req);
  if ("error" in auth) return auth.error;
  try {
    const sp = req.nextUrl.searchParams;
    const orgId = strField(sp.get("orgId"), 40);
    const action = strField(sp.get("action"), 40);
    const actorId = strField(sp.get("actorId"), 40);
    const q = strField(sp.get("q"), 60);
    const page = Math.max(1, Math.min(1000, Number(sp.get("page")) || 1));
    const pageSize = Math.max(1, Math.min(100, Number(sp.get("pageSize")) || 30));

    const where = {
      ...(orgId ? { orgId } : {}),
      ...(action ? { action } : {}),
      ...(actorId ? { actorId } : {}),
      ...(q ? { OR: [{ actorName: { contains: q } }, { action: { contains: q } }] } : {}),
    };

    const [total, rows] = await Promise.all([
      db.adminAccessLog.count({ where }),
      db.adminAccessLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, orgId || null, "VIEW_ACCESS_LOGS", req);
    return Response.json({
      logs: rows.map((l) => ({
        id: l.id,
        actorId: l.actorId,
        actorName: l.actorName,
        orgId: l.orgId,
        action: l.action,
        detail: l.detail,
        ip: l.ip,
        createdAt: l.createdAt,
      })),
      total,
      page,
      pageSize,
    });
  } catch (e) {
    console.error("sa access-logs error", e);
    return Response.json({ error: "خطا در دریافت لاگ دسترسی" }, { status: 500 });
  }
}
