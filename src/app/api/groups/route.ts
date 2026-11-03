import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, canSeePurchasePrice } from "@/lib/auth";
import { strField } from "@/lib/validate";
import { notifyCatalogChange } from "@/lib/notify";

/** حذف قیمت خرید از خروجی اگر کاربر مجاز نباشد */
function stripPurchase<T extends { pricePurchase: number }>(
  rows: T[],
  allowed: boolean
): (T & { pricePurchase: number | null })[] {
  return rows.map((p) => ({ ...p, pricePurchase: allowed ? p.pricePurchase : null }));
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, "products");
  if ("error" in auth) return auth.error;
  const allowed = canSeePurchasePrice(auth.ctx);
  const groups = await db.productGroup.findMany({
    include: { products: { orderBy: { createdAt: "desc" } } },
    orderBy: { createdAt: "desc" },
  });
  return Response.json(
    groups.map((g) => ({ ...g, products: stripPurchase(g.products, allowed) }))
  );
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, "products");
  if ("error" in auth) return auth.error;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = strField(body.name, 80);
    if (!name) return Response.json({ error: "نام گروه الزامی است" }, { status: 400 });
    const group = await db.productGroup.create({ data: { name } });
    await notifyCatalogChange(auth.ctx.user.id, "گروه کالای جدید", `گروه «${name}» توسط مدیر اضافه شد — لیست کالاها به‌روز است`);
    return Response.json(group, { status: 201 });
  } catch (e) {
    console.error("create group error", e);
    return Response.json({ error: "خطا در ساخت گروه" }, { status: 500 });
  }
}
