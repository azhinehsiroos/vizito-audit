import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, canSeePurchasePrice } from "@/lib/auth";
import { strField, strOrNull, clampNum, isSafeImageDataUrl } from "@/lib/validate";
import { notifyCatalogChange } from "@/lib/notify";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, "products");
  if ("error" in auth) return auth.error;
  const allowed = canSeePurchasePrice(auth.ctx);
  const groupId = req.nextUrl.searchParams.get("groupId");
  const products = await db.product.findMany({
    where: groupId ? { groupId } : undefined,
    include: { group: true },
    orderBy: { createdAt: "desc" },
  });
  return Response.json(
    products.map((p) => ({ ...p, pricePurchase: allowed ? p.pricePurchase : null }))
  );
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, "products");
  if ("error" in auth) return auth.error;
  const allowed = canSeePurchasePrice(auth.ctx);
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = strField(body.name, 120);
    const groupId = strField(body.groupId, 40);
    if (!name) return Response.json({ error: "نام کالا الزامی است" }, { status: 400 });
    if (!groupId) return Response.json({ error: "انتخاب گروه الزامی است" }, { status: 400 });
    const group = await db.productGroup.findUnique({ where: { id: groupId } });
    if (!group) return Response.json({ error: "گروه یافت نشد" }, { status: 404 });
    const image = typeof body.image === "string" ? body.image : null;
    if (image && (!isSafeImageDataUrl(image) || image.length > 2_500_000)) {
      return Response.json({ error: "تصویر نامعتبر است (فرمت PNG/JPEG/WEBP و حداکثر ۲.۵ مگابایت)" }, { status: 400 });
    }

    const product = await db.product.create({
      data: {
        groupId,
        name,
        image: image || null,
        description: strOrNull(body.description, 1000),
        volume: strOrNull(body.volume, 40),
        offer: strOrNull(body.offer, 140),
        // قیمت خرید فقط با اجازه مدیر ثبت می‌شود
        pricePurchase: allowed ? clampNum(body.pricePurchase, 0, 9_999_999_999) : 0,
        priceStore: clampNum(body.priceStore, 0, 9_999_999_999),
        pricePharmacy: clampNum(body.pricePharmacy, 0, 9_999_999_999),
        priceSalon: clampNum(body.priceSalon, 0, 9_999_999_999),
        discount: clampNum(body.discount, 0, 100),
        minOrder: Math.max(1, Math.round(clampNum(body.minOrder, 1, 100_000, 1))),
      },
    });
    await notifyCatalogChange(
      auth.ctx.user.id,
      "کالای جدید به کاتالوگ اضافه شد",
      `کالای «${name}» توسط مدیر ثبت شد — لیست کالاها و قیمت‌ها به‌روز است`
    );
    return Response.json(
      { ...product, pricePurchase: allowed ? product.pricePurchase : null },
      { status: 201 }
    );
  } catch (e) {
    console.error("create product error", e);
    return Response.json({ error: "خطا در ثبت کالا" }, { status: 500 });
  }
}
