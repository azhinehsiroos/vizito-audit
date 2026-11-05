import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden } from "@/lib/auth";
import { deleteBackup } from "@/lib/backup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** حذف یک نسخه پشتیبان (فایل + ردیف) — فقط مدیر و فقط داخل مجموعه خودش */
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) return forbidden("پشتیبان‌گیری فقط توسط مدیر برنامه امکان‌پذیر است");
  const { id } = await params;
  try {
    // چندمجموعه‌ای: مدیر مجموعه نمی‌تواند بکاپ سایر مجموعه‌ها یا بکاپ کامل سرور را حذف کند
    const row = await db.backup.findUnique({ where: { id }, select: { orgId: true } });
    if (!row) return Response.json({ error: "نسخه پشتیبان یافت نشد" }, { status: 404 });
    if (auth.ctx.org && row.orgId !== auth.ctx.org.id) {
      return Response.json({ error: "نسخه پشتیبان یافت نشد" }, { status: 404 });
    }
    const ok = await deleteBackup(id);
    if (!ok) return Response.json({ error: "نسخه پشتیبان یافت نشد" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (e) {
    console.error("backup delete error", e);
    return Response.json({ error: "خطا در حذف نسخه پشتیبان" }, { status: 500 });
  }
}
