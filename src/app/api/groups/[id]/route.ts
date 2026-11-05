import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden } from "@/lib/auth";
import { strField } from "@/lib/validate";
import { notifyCatalogChange } from "@/lib/notify";

type Params = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, "products");
  if ("error" in auth) return auth.error;
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = strField(body.name, 80);
    if (!name) return Response.json({ error: "نام گروه الزامی است" }, { status: 400 });
    const existing = await db.productGroup.findUnique({ where: { id } });
    if (!existing || (auth.ctx.org && existing.orgId !== auth.ctx.org.id)) {
      return Response.json({ error: "گروه یافت نشد" }, { status: 404 });
    }
    const group = await db.productGroup.update({ where: { id }, data: { name } });
    await notifyCatalogChange(
      auth.ctx.user.id,
      auth.ctx.org ? auth.ctx.org.id : null,
      "بروزرسانی گروه کالا", `گروه «${name}» توسط مدیر ویرایش شد — لیست کالاها به‌روز است`);
    return Response.json(group);
  } catch {
    return Response.json({ error: "خطا در ویرایش گروه" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, "products");
  if ("error" in auth) return auth.error;
  // امنیت (ممیزی v1.1.2) — حذف گروه، «همه» کالاهای آن را هم cascade می‌کند؛
  // این عمل مخرب کاتالوگ مشترک فقط توسط مدیر ممکن است
  if (!auth.ctx.isAdmin) {
    return forbidden("حذف گروه کالا فقط توسط مدیر امکان‌پذیر است");
  }
  const { id } = await params;
  try {
    const group = await db.productGroup.findUnique({ where: { id } });
    // چندمجموعه‌ای: گروه مجموعه دیگر ← ۴۰۴ بدون افشا (حذف cascade فقط داخل مجموعه)
    if (!group || (auth.ctx.org && group.orgId !== auth.ctx.org.id)) {
      return Response.json({ error: "گروه یافت نشد" }, { status: 404 });
    }
    await db.productGroup.delete({ where: { id } });
    await notifyCatalogChange(
      auth.ctx.user.id,
      auth.ctx.org ? auth.ctx.org.id : null,
      "حذف گروه کالا", `گروه «${group?.name ?? ""}» و کالاهای آن حذف شد — لیست کالاها به‌روز است`);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "خطا در حذف گروه" }, { status: 500 });
  }
}
