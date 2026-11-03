import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
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
    const group = await db.productGroup.update({ where: { id }, data: { name } });
    await notifyCatalogChange(auth.ctx.user.id, "بروزرسانی گروه کالا", `گروه «${name}» توسط مدیر ویرایش شد — لیست کالاها به‌روز است`);
    return Response.json(group);
  } catch {
    return Response.json({ error: "خطا در ویرایش گروه" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, "products");
  if ("error" in auth) return auth.error;
  const { id } = await params;
  try {
    const group = await db.productGroup.findUnique({ where: { id } });
    await db.productGroup.delete({ where: { id } });
    await notifyCatalogChange(auth.ctx.user.id, "حذف گروه کالا", `گروه «${group?.name ?? ""}» و کالاهای آن حذف شد — لیست کالاها به‌روز است`);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "خطا در حذف گروه" }, { status: 500 });
  }
}
