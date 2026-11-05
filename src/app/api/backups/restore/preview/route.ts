import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden, tooMany } from "@/lib/auth";
import { dbRateLimit, dbRetryAfterSeconds } from "@/lib/rate-limit";
import { readRestoreSource, buildRestoreWarnings, TABLE_LABELS_FA } from "@/lib/restore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * پیش‌نمایش بازیابی — مرحله اول جریان دومرحله‌ای.
 * پاکت رمزگشایی و اعتبارسنجی می‌شود و فقط شمارش‌ها/هشدارها برمی‌گردد؛
 * در این مرحله هیچ داده‌ای تغییر نمی‌کند.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) return forbidden("بازیابی نسخه پشتیبان فقط توسط مدیر امکان‌پذیر است");
  const key = `rs-pre:${auth.ctx.user.id}`;
  if (!(await dbRateLimit(key, 5, 60 * 1000))) return tooMany(await dbRetryAfterSeconds(key));

  let body: { id?: unknown; file?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "درخواست نامعتبر است" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const file = typeof body.file === "string" ? body.file : "";
  if ((!id && !file) || (id && file)) {
    return Response.json({ error: "دقیقاً یکی از «شناسه نسخه» یا «فایل پشتیبان» لازم است" }, { status: 400 });
  }

  try {
    const src = await readRestoreSource({
      id: id || undefined,
      file: file || undefined,
      ctxOrgId: auth.ctx.org ? auth.ctx.org.id : null,
      isSuperAdmin: auth.ctx.isSuperAdmin,
    });
    if ("error" in src) return src.error;

    let orgName: string | null = null;
    if (src.parsed.scope === "ORG") {
      const org = await db.org.findUnique({ where: { id: src.parsed.orgId as string }, select: { name: true } });
      if (!org) {
        return Response.json({ error: "مجموعه این نسخه پشتیبان دیگر وجود ندارد" }, { status: 400 });
      }
      orgName = org.name;
    }
    const warnings = await buildRestoreWarnings(src.parsed);
    const counts: Record<string, number> = {};
    for (const [k, rows] of Object.entries(src.parsed.tables)) counts[k] = rows.length;

    return Response.json({
      scope: src.parsed.scope,
      orgId: src.parsed.orgId,
      orgName,
      createdAt: src.parsed.createdAt,
      counts,
      tableLabels: TABLE_LABELS_FA,
      warnings,
    });
  } catch (e) {
    console.error("restore preview error", e);
    return Response.json({ error: "خطا در بررسی نسخه پشتیبان" }, { status: 500 });
  }
}
