import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, canSeePurchasePrice } from "@/lib/auth";
import { strField, strOrNull, clampNum, isSafeImageDataUrl } from "@/lib/validate";
import { notifyCatalogChange } from "@/lib/notify";

type Params = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, "products");
  if ("error" in auth) return auth.error;
  const allowed = canSeePurchasePrice(auth.ctx);
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = strField(body.name, 120);
    if (!name) return Response.json({ error: "نام کالا الزامی است" }, { status: 400 });
    const image = typeof body.image === "string" ? body.image : null;
    if (image && (!isSafeImageDataUrl(image) || image.length > 2_500_000)) {
      return Response.json({ error: "تصویر نامعتبر است (فرمت PNG/JPEG/WEBP و حداکثر ۲.۵ مگابایت)" }, { status: 400 });
    }
    const existing = await db.product.findUnique({ where: { id } });
    if (!existing) return Response.json({ error: "کالا یافت نشد" }, { status: 404 });
    // چندمجموعه‌ای: کالای مجموعه دیگر ← ۴۰۴ بدون افشا
    if (auth.ctx.org && existing.orgId !== auth.ctx.org.id) {
      return Response.json({ error: "کالا یافت نشد" }, { status: 404 });
    }
    // گروه مقصد باید معتبر باشد
    const groupId = strField(body.groupId, 40) || existing.groupId;
    const group = await db.productGroup.findUnique({ where: { id: groupId } });
    if (!group) return Response.json({ error: "گروه یافت نشد" }, { status: 404 });
    if (auth.ctx.org && group.orgId !== auth.ctx.org.id) {
      return Response.json({ error: "گروه یافت نشد" }, { status: 404 });
    }
    const product = await db.product.update({
      where: { id },
      data: {
        name,
        groupId,
        image: image || null,
        description: strOrNull(body.description, 1000),
        volume: strOrNull(body.volume, 40),
        offer: strOrNull(body.offer, 140),
        // کاربر بدون اجازه، قیمت خرید قبلی را دست‌نخورده می‌گذارد
        pricePurchase: allowed ? clampNum(body.pricePurchase, 0, 9_999_999_999) : existing.pricePurchase,
        priceStore: clampNum(body.priceStore, 0, 9_999_999_999),
        pricePharmacy: clampNum(body.pricePharmacy, 0, 9_999_999_999),
        priceSalon: clampNum(body.priceSalon, 0, 9_999_999_999),
        discount: clampNum(body.discount, 0, 100),
        minOrder: Math.max(1, Math.round(clampNum(body.minOrder, 1, 100_000, 1))),
      },
    });
    await notifyCatalogChange(
      auth.ctx.user.id,
      auth.ctx.org ? auth.ctx.org.id : null,
      "بروزرسانی کالا و قیمت‌ها",
      `اطلاعات و قیمت‌های کالای «${name}» توسط مدیر به‌روزرسانی شد — لیست کالاها به‌روز است`
    );
    return Response.json(
      { ...product, pricePurchase: allowed ? product.pricePurchase : null }
    );
  } catch (e) {
    console.error("update product error", e);
    return Response.json({ error: "خطا در ویرایش کالا" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, "products");
  if ("error" in auth) return auth.error;
  const { id } = await params;
  try {
    const existing = await db.product.findUnique({ where: { id }, select: { name: true, orgId: true } });
    if (!existing || (auth.ctx.org && existing.orgId !== auth.ctx.org.id)) {
      return Response.json({ error: "کالا یافت نشد" }, { status: 404 });
    }
    const used = await db.orderItem.count({ where: { productId: id } });
    if (used > 0) {
      // فقط قطع ارتباط تا سوابق سفارش حفظ شود
      await db.product.update({ where: { id }, data: { orderItems: { set: [] } } });
    }
    await db.product.delete({ where: { id } });
    await notifyCatalogChange(
      auth.ctx.user.id,
      auth.ctx.org ? auth.ctx.org.id : null,
      "حذف کالا از کاتالوگ", `کالای «${existing?.name ?? ""}» توسط مدیر حذف شد — لیست کالاها به‌روز است`);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "خطا در حذف کالا" }, { status: 500 });
  }
}
