import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, canSeeAllCustomers, canSeePurchasePrice, type AuthContext } from "@/lib/auth";
import { strField, strOrNull, inWhitelist } from "@/lib/validate";

type Params = { params: Promise<{ id: string }> };

const SETTLEMENT_TYPES = ["CASH", "CHECK", "RECEIPT"];
const PRICE_TYPES = ["STORE", "PHARMACY", "SALON", "PURCHASE"] as const;

/** سفارش در محدوده دسترسی است اگر مدیر/دارای all_customers باشد، یا سفارشِ خودش باشد، یا متعلق به مشتریِ خودش باشد */
function orderInScope(
  order: { createdByUserId: string | null; customer: { createdBy: string | null } },
  ctx: AuthContext
): boolean {
  if (canSeeAllCustomers(ctx)) return true;
  return order.createdByUserId === ctx.user.id || order.customer.createdBy === ctx.user.id;
}

function settlementTypeOrNull(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return SETTLEMENT_TYPES.includes(s) ? s : null;
}

function dueDaysOrNull(v: unknown): number | null {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(3650, n);
}

export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, "orders");
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const order = await db.order.findUnique({
    where: { id },
    include: { customer: true, items: true, createdByUser: { select: { name: true, company: true } } },
  });
  // چندمجموعه‌ای: سفارش مجموعه دیگر ← ۴۰۴ بدون افشا — حتی برای مدیر
  if (!order || (auth.ctx.org && order.orgId !== auth.ctx.org.id) || !orderInScope(order, auth.ctx)) {
    return Response.json({ error: "سفارش یافت نشد" }, { status: 404 });
  }
  // ممیزی v1.1.2 — فاکتور خرید برای کاربر بدون مجوز purchase_price دیده نمی‌شود (۴۰۴ بدون افشا)
  if (order.priceType === "PURCHASE" && !canSeePurchasePrice(auth.ctx)) {
    return Response.json({ error: "سفارش یافت نشد" }, { status: 404 });
  }
  return Response.json(order);
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, "orders");
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const order = await db.order.findUnique({ where: { id }, include: { customer: true } });
  if (!order || (auth.ctx.org && order.orgId !== auth.ctx.org.id) || !orderInScope(order, auth.ctx)) {
    return Response.json({ error: "سفارش یافت نشد" }, { status: 404 });
  }
  // ممیزی v1.1.2 — فاکتور خرید برای کاربر بدون مجوز purchase_price قابل مشاهده/تغییر نیست
  if (order.priceType === "PURCHASE" && !canSeePurchasePrice(auth.ctx)) {
    return Response.json({ error: "سفارش یافت نشد" }, { status: 404 });
  }
  // امنیت: حذف فاکتور فقط توسط مدیر یا ثبت‌کننده — مثل ویرایش
  if (!auth.ctx.isAdmin && order.createdByUserId !== auth.ctx.user.id) {
    return Response.json({ error: "فقط مدیر یا ثبت‌کننده اجازه حذف این فاکتور را دارد" }, { status: 403 });
  }
  try {
    await db.order.delete({ where: { id } });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "خطا در حذف سفارش" }, { status: 500 });
  }
}

const num = (v: unknown, min: number, max: number, fallback = 0): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** ویرایش فاکتور — فقط مدیر یا ثبت‌کننده (در محدوده دسترسی) */
export async function PUT(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, "orders");
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const existing = await db.order.findUnique({ where: { id }, include: { customer: true } });
  if (!existing || (auth.ctx.org && existing.orgId !== auth.ctx.org.id) || !orderInScope(existing, auth.ctx)) {
    return Response.json({ error: "سفارش یافت نشد" }, { status: 404 });
  }
  // ممیزی v1.1.2 — فاکتور خرید برای کاربر بدون مجوز purchase_price قابل ویرایش نیست
  if (existing.priceType === "PURCHASE" && !canSeePurchasePrice(auth.ctx)) {
    return Response.json({ error: "سفارش یافت نشد" }, { status: 404 });
  }
  if (!auth.ctx.isAdmin && existing.createdByUserId !== auth.ctx.user.id) {
    return Response.json({ error: "فقط مدیر یا ثبت‌کننده اجازه ویرایش این فاکتور را دارد" }, { status: 403 });
  }
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) {
      return Response.json({ error: "حداقل یک ردیف کالا لازم است" }, { status: 400 });
    }
    if (items.length > 100) {
      return Response.json({ error: "تعداد ردیف‌های فاکتور بیش از حد مجاز است" }, { status: 400 });
    }
    const title = body.title === undefined ? existing.title : strOrNull(body.title, 120);
    const note = body.note === undefined ? existing.note : strOrNull(body.note, 500);
    const priceType =
      typeof body.priceType === "string"
        ? inWhitelist(body.priceType, PRICE_TYPES, existing.priceType as (typeof PRICE_TYPES)[number])
        : existing.priceType;
    // ممیزی امنیتی — تغییر نوع فاکتور به «خرید» (PURCHASE) فقط برای دارای مجوز purchase_price؛
    // تلاش غیرمجاز برای ارتقای نوع فاکتور عادی ← ۴۰۳ (نوع‌های دیگر بدون تغییر)
    if (priceType === "PURCHASE" && !canSeePurchasePrice(auth.ctx)) {
      return Response.json(
        { error: "شما اجازه ثبت فاکتور با نوع «خرید» را ندارید" },
        { status: 403 }
      );
    }
    const settlementType = body.settlementType === undefined ? existing.settlementType : settlementTypeOrNull(body.settlementType);
    const dueDays = body.dueDays === undefined ? existing.dueDays : dueDaysOrNull(body.dueDays);

    type NewItem = {
      productId: string | null;
      productName: string;
      quantity: number;
      volume: string | null;
      price: number;
      discount: number;
      offer: string | null;
      lineTotal: number;
    };
    /** سقف قیمت ردیف دستی (بدون کالای کاتالوگ) — جلوگیری از مبلغ‌های نجومی در فاکتور */
    const MANUAL_PRICE_CAP = 1_000_000_000;
    const parsed: NewItem[] = [];
    // امنیت: قیمت کالاهای کاتالوگ فقط از دیتابیس خوانده می‌شود
    const ids = items
      .map((raw) => (raw && typeof raw === "object" ? strOrNull((raw as Record<string, unknown>).productId, 40) : null))
      .filter((v): v is string => !!v);
    const productMap = new Map<
      string,
      { name: string; volume: string | null; priceStore: number; pricePharmacy: number; priceSalon: number; pricePurchase: number }
    >();
    if (ids.length > 0) {
      const found = await db.product.findMany({
        where: { id: { in: [...new Set(ids)] }, ...(auth.ctx.org ? { orgId: auth.ctx.org.id } : {}) },
        select: { id: true, name: true, volume: true, priceStore: true, pricePharmacy: true, priceSalon: true, pricePurchase: true },
      });
      for (const p of found) productMap.set(p.id, p);
    }
    const priceFieldFor = (t: string): "priceStore" | "pricePharmacy" | "priceSalon" | "pricePurchase" =>
      t === "PHARMACY" ? "pricePharmacy" : t === "SALON" ? "priceSalon" : t === "PURCHASE" ? "pricePurchase" : "priceStore";
    const effectiveType =
      priceType === "PURCHASE" && !canSeePurchasePrice(auth.ctx) ? "STORE" : (priceType as "STORE" | "PHARMACY" | "SALON" | "PURCHASE");

    for (const raw of items) {
      if (!raw || typeof raw !== "object") continue;
      const it = raw as Record<string, unknown>;
      const productName = strField(it.productName, 140);
      if (!productName) continue;
      const quantity = num(it.quantity, 0, 1_000_000);
      if (quantity <= 0) continue;
      const discount = num(it.discount, 0, 100);
      const productId = strOrNull(it.productId, 40);
      let price = num(it.price, 0, 9_999_999_999); // ممیزی v1.1.2 — سقف یکسان با مسیر ایجاد (قبلاً ۱۰ برابر بود)
      let volume = strOrNull(it.volume, 40);
      let name = productName;
      const p = productId ? productMap.get(productId) : undefined;
      if (productId) {
        if (!p) {
          return Response.json({ error: `کالای «${productName}» یافت نشد` }, { status: 400 });
        }
        // قیمت ردیف — مثل مسیر ایجاد:
        //  - مدیر: قیمت واردشده معتبر است
        //  - کاربر عادی: قیمت ثبت‌شدهٔ کاتالوگ (>۰) ملاک است؛ کالای بدون قیمت ← قیمت دستی
        const catalogPrice = p[priceFieldFor(effectiveType)];
        if (auth.ctx.isAdmin || catalogPrice <= 0) {
          price = Math.min(price, auth.ctx.isAdmin ? 9_999_999_999 : MANUAL_PRICE_CAP);
        } else {
          price = catalogPrice;
        }
        name = p.name.slice(0, 140);
        volume = p.volume ?? volume;
      } else {
        // ردیف دستی: سقف قیمت برای جلوگیری از ثبت مبلغ نجومی
        price = Math.min(price, MANUAL_PRICE_CAP);
      }
      parsed.push({
        productId,
        productName: name,
        quantity,
        volume,
        price,
        discount,
        offer: strOrNull(it.offer, 140),
        lineTotal: Math.max(0, Math.round(quantity * price * (1 - discount / 100))),
      });
    }
    if (parsed.length === 0) {
      return Response.json({ error: "ردیف‌های فاکتور نامعتبر است" }, { status: 400 });
    }
    const totalAmount = parsed.reduce((s, it) => s + it.lineTotal, 0);

    const updated = await db.$transaction(async (tx) => {
      await tx.orderItem.deleteMany({ where: { orderId: id } });
      await tx.orderItem.createMany({
        data: parsed.map((it, i) => ({ ...it, orderId: id, rowNumber: i + 1 })),
      });
      return tx.order.update({
        where: { id },
        data: { title, note, priceType, settlementType, dueDays, totalAmount },
        include: { customer: true, items: { orderBy: { rowNumber: "asc" } } },
      });
    });
    return Response.json(updated);
  } catch (e) {
    console.error("update order error", e);
    return Response.json({ error: "خطا در ویرایش فاکتور" }, { status: 500 });
  }
}
