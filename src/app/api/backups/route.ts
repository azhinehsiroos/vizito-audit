import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden, tooMany } from "@/lib/auth";
import { rateLimit, retryAfterSeconds, getClientIp } from "@/lib/rate-limit";
import { getSchedule, lastAutoBackups, createBackup } from "@/lib/backup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** فهرست نسخه‌های پشتیبان + برنامه زمان‌بندی — فقط مدیر */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) return forbidden("پشتیبان‌گیری فقط توسط مدیر برنامه امکان‌پذیر است");
  try {
    const [backups, schedule, lastAuto] = await Promise.all([
      // چندمجموعه‌ای: مدیر فقط نسخه‌های مجموعه خودش؛ سازنده (بدون مجموعه) همه را می‌بیند
      db.backup.findMany({ where: auth.ctx.org ? { orgId: auth.ctx.org.id } : {}, orderBy: { createdAt: "desc" }, take: 60 }),
      getSchedule(),
      lastAutoBackups(),
    ]);
    return Response.json({
      schedule,
      lastAuto,
      backups: backups.map((b) => ({
        id: b.id,
        kind: b.kind,
        sizeBytes: b.sizeBytes,
        counts: b.counts,
        createdByName: b.createdByName,
        createdAt: b.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    console.error("backups list error", e);
    return Response.json({ error: "خطا در دریافت نسخه‌های پشتیبان" }, { status: 500 });
  }
}

/** تهیه نسخه پشتیبان دستی — فقط مدیر (با محدودیت نرخ برای جلوگیری از پر شدن دیسک) */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) return forbidden("پشتیبان‌گیری فقط توسط مدیر برنامه امکان‌پذیر است");
  const key = `bk:${auth.ctx.user.id}:${getClientIp(req)}`;
  if (!rateLimit(key, 10, 60 * 60 * 1000)) {
    return tooMany(retryAfterSeconds(key), "تعداد پشتیبان‌گیری‌های دستی زیاد است — کمی بعد دوباره تلاش کنید");
  }
  try {
    // چندمجموعه‌ای: بکاپ مدیر مجموعه فقط شامل داده‌های مجموعه خودش است
    const row = await createBackup("MANUAL", { id: auth.ctx.user.id, name: auth.ctx.user.name }, auth.ctx.org ? auth.ctx.org.id : null);
    return Response.json({
      backup: {
        id: row.id,
        kind: row.kind,
        sizeBytes: row.sizeBytes,
        counts: row.counts,
        createdByName: row.createdByName,
        createdAt: row.createdAt.toISOString(),
      },
    });
  } catch (e) {
    console.error("backup create error", e);
    return Response.json({ error: "خطا در تهیه نسخه پشتیبان" }, { status: 500 });
  }
}
