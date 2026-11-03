import fs from "fs";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden } from "@/lib/auth";
import { safeBackupPath } from "@/lib/backup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * دانلود فایل نسخه پشتیبان — فقط مدیر.
 * امنیت: نام فایل فقط از ردیف دیتابیس خوانده می‌شود (هیچ ورودی کاربر در مسیر فایل نیست)
 * و پوشه backups خارج از public است ⇒ دسترسی مستقیم HTTP به فایل‌ها ممکن نیست.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) return forbidden("پشتیبان‌گیری فقط توسط مدیر برنامه امکان‌پذیر است");
  const { id } = await params;
  try {
    const row = await db.backup.findUnique({ where: { id } });
    if (!row) return Response.json({ error: "نسخه پشتیبان یافت نشد" }, { status: 404 });
    const p = safeBackupPath(row.fileName);
    if (!p || !fs.existsSync(p)) {
      return Response.json({ error: "فایل نسخه پشتیبان یافت نشد" }, { status: 404 });
    }
    const buf = fs.readFileSync(p);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${row.fileName}"`,
        "Content-Length": String(buf.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("backup download error", e);
    return Response.json({ error: "خطا در دانلود نسخه پشتیبان" }, { status: 500 });
  }
}
