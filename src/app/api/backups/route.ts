import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden, tooMany } from "@/lib/auth";
import { rateLimit, retryAfterSeconds, getClientIp } from "@/lib/rate-limit";
import { getSchedule, lastAutoBackups, createBackup } from "@/lib/backup";
import { logSaAccess } from "@/lib/sa";

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
    // M3: فهرست همه‌بکاپ‌ها توسط سازنده (نمای کل نصب) — حسابرسی fail-closed
    if (!auth.ctx.org) {
      await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, null, "VIEW_BACKUPS_ALL", req, `count=${backups.length}`);
    }
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
    // فاز D — «مجموعه من»: پیش‌فرض، بکاپ سازنده هم مثل مدیر مجموعه محدود به مجموعه خودش است؛
    // بکاپ FULL (کل سرور) ابزار زیرساختی سازنده می‌ماند — فقط با opt-in صریح
    // {"scope":"FULL"} و فقط برای نقش SUPER_ADMIN (حتی وقتی «مجموعه من» دارد) —
    // با همان حسابرسی BACKUP_FULL. مدیر مجموعه هرگز FULL نمی‌تواند بگیرد.
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.scope === "FULL" && !auth.ctx.isSuperAdmin) {
      return forbidden("بکاپ کامل سرور فقط توسط سازنده برنامه امکان‌پذیر است");
    }
    const full = body.scope === "FULL" && auth.ctx.isSuperAdmin;
    // چندمجموعه‌ای: بکاپ مدیر مجموعه فقط شامل داده‌های مجموعه خودش است
    const row = await createBackup("MANUAL", { id: auth.ctx.user.id, name: auth.ctx.user.name }, full ? null : auth.ctx.org ? auth.ctx.org.id : null);
    // M3: بکاپ FULL توسط سازنده (کل نصب) — حسابرسی fail-closed
    if (full) {
      await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, null, "BACKUP_FULL", req, `backup=${row.id.slice(0, 12)}`);
    }
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
