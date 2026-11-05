import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, canSeePurchasePrice, canSeeAllCustomers, type AuthContext } from "@/lib/auth";
import { strField, strOrNull, clampNum, inWhitelist, VALID_PRICE_TYPES, isFiniteDate } from "@/lib/validate";

const MAX_ITEMS = 200;

/** سقف قیمت ردیف دستی (بدون کالای کاتالوگ) — جلوگیری از مبلغ‌های نجومی در فاکتور */
const MANUAL_PRICE_CAP = 1_000_000_000;

/** نحوه تسویه قابل ثبت روی فاکتور */
const VALID_SETTLEMENT_TYPES = ["CASH", "CHECK", "RECEIPT"] as const;

/** فقط مقدار مجاز قبول است؛ در غیر این صورت null (انتخاب نشده) — مقایسه بدون حساسیت به بزرگی/کوچکی حروف */
function settlementTypeOrNull(v: unknown): (typeof VALID_SETTLEMENT_TYPES)[number] | null {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return (VALID_SETTLEMENT_TYPES as readonly string[]).includes(s)
    ? (s as (typeof VALID_SETTLEMENT_TYPES)[number])
    : null;
}

/** سررسید تسویه به روز — بازه ۱ تا ۳۶۵۰؛ غایب/صفر/نامعتبر ← null */
function dueDaysOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(3650, Math.max(1, Math.round(n)));
}

/** شرط محدوده سفارش‌ها: اول مجموعه خود کاربر؛ بعد مدیر/دارای all_customers ← همهِ مجموعه؛ بقیه فقط سفارش‌های خودشان */
function orderScope(ctx: AuthContext) {
  const orgScope = ctx.org ? { orgId: ctx.org.id } : {};
  if (canSeeAllCustomers(ctx)) return orgScope;
  return {
    ...orgScope,
    OR: [{ customer: { createdBy: ctx.user.id } }, { createdByUserId: ctx.user.id }],
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, "orders");
  if ("error" in auth) return auth.error;
  const customerId = strField(req.nextUrl.searchParams.get("customerId"), 40);
  const from = req.nextUrl.searchParams.get("from");
  const to = req.nextUrl.searchParams.get("to");
  const orders = await db.order.findMany({
    where: {
      ...orderScope(auth.ctx),
      // ممیزی v1.1.2 — فاکتور خرید (نوع قیمت PURCHASE) خودِ داده‌ی قیمت خرید است؛
      // برای کاربر بدون مجوز purchase_price دیده نمی‌شود (مثل خودِ قیمت خرید در کاتالوگ)
      ...(canSeePurchasePrice(auth.ctx) ? {} : { priceType: { not: "PURCHASE" } }),
      ...(customerId ? { customerId } : {}),
      ...(isFiniteDate(from) || isFiniteDate(to)
        ? {
            createdAt: {
              ...(isFiniteDate(from) ? { gte: new Date(from as string) } : {}),
              ...(isFiniteDate(to) ? { lte: new Date(to as string) } : {}),
            },
          }
        : {}),
    },
    include: { customer: true, items: true, createdByUser: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });
  return Response.json(orders);
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, "orders");
  if ("error" in auth) return auth.error;
  const purchaseAllowed = canSeePurchasePrice(auth.ctx);
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const customerId = strField(body.customerId, 40);
    if (!customerId) return Response.json({ error: "انتخاب مشتری الزامی است" }, { status: 400 });
    const customer = await db.customer.findUnique({ where: { id: customerId } });
    if (!customer || (auth.ctx.org && customer.orgId !== auth.ctx.org.id)) {
      return Response.json({ error: "مشتری یافت نشد" }, { status: 404 });
    }
    // ممیزی v1.1.2 — مشتری آرشیوشده خارج از چرخه فعال است؛ سفارش جدید روی او ثبت نمی‌شود
    if (customer.archived) {
      return Response.json(
        { error: "این مشتری آرشیو شده است — برای ثبت سفارش ابتدا آن را از آرشیو خارج کنید" },
        { status: 400 }
      );
    }
    // ثبت سفارش فقط برای مشتری‌های داخل محدوده دسترسی کاربر
    if (!canSeeAllCustomers(auth.ctx) && customer.createdBy !== auth.ctx.user.id) {
      return Response.json(
        { error: "این مشتری در محدوده دسترسی شما نیست — سفارش فقط برای مشتری‌های خودتان یا (در صورت داشتن مجوز) تمام مشتری‌ها" },
        { status: 403 }
      );
    }

    // نوع قیمت فقط از لیست مجاز — قیمت خرید فقط برای دارای اجازه
    let priceType = inWhitelist(body.priceType, VALID_PRICE_TYPES, "STORE");
    if (priceType === "PURCHASE" && !purchaseAllowed) priceType = "STORE";

    const rawItems = Array.isArray(body.items) ? body.items.slice(0, MAX_ITEMS) : [];
    const items = rawItems.filter(
      (it: Record<string, unknown>) =>
        typeof it === "object" && it !== null && strField(it.productName, 120) && clampNum(it.quantity, 0, 1_000_000) > 0
    );
    if (items.length === 0) {
      return Response.json({ error: "حداقل یک ردیف سفارش لازم است" }, { status: 400 });
    }

    // امنیت: قیمت کالاهای کاتالوگ فقط از دیتابیس خوانده می‌شود — قیمت ارسالی کلاینت قابل اعتماد نیست
    const productIds = items
      .map((it: Record<string, unknown>) => strField(it.productId, 40))
      .filter((v: string | null): v is string => !!v);
    const productMap = new Map<string, { name: string; volume: string | null; priceStore: number; pricePharmacy: number; priceSalon: number; pricePurchase: number }>();
    if (productIds.length > 0) {
      const found = await db.product.findMany({
        where: { id: { in: [...new Set(productIds)] }, ...(auth.ctx.org ? { orgId: auth.ctx.org.id } : {}) },
        select: { id: true, name: true, volume: true, priceStore: true, pricePharmacy: true, priceSalon: true, pricePurchase: true },
      });
      for (const p of found) productMap.set(p.id, p);
    }
    const priceFieldFor = (t: string): "priceStore" | "pricePharmacy" | "priceSalon" | "pricePurchase" =>
      t === "PHARMACY" ? "pricePharmacy" : t === "SALON" ? "priceSalon" : t === "PURCHASE" ? "pricePurchase" : "priceStore";

    const rows: {
      productId: string | null;
      productName: string;
      quantity: number;
      volume: string | null;
      price: number;
      discount: number;
      offer: string | null;
      lineTotal: number;
      rowNumber: number;
    }[] = [];
    for (let idx = 0; idx < items.length; idx++) {
      const it = items[idx] as Record<string, unknown>;
      const qty = clampNum(it.quantity, 0, 1_000_000);
      const discount = clampNum(it.discount, 0, 100); // سقف تخفیف: حداکثر ۱۰۰٪
      const productId = strField(it.productId, 40) || null;
      let price = clampNum(it.price, 0, 9_999_999_999);
      let productName = strField(it.productName, 120);
      let volume = strOrNull(it.volume, 40);
      const p = productId ? productMap.get(productId) : undefined;
      if (productId) {
        if (!p) {
          return Response.json({ error: `کالای ردیف ${idx + 1} یافت نشد` }, { status: 400 });
        }
        // قیمت ردیف:
        //  - مدیر: قیمت واردشده در فاکتور معتبر است (کاتالوگ تحت اختیار خود اوست)
        //  - کاربر عادی: اگر کاتالوگ برای این نوع قیمت قیمت ثبت‌شده (>۰) دارد، همان ملاک است
        //    (ضد تقلب)؛ کالای بدون قیمت کاتالوگ ← قیمت دستیِ ردیف مثل ردیف دستی پذیرفته می‌شود
        //    تا فاکتور کالای تازه‌ساخت همیشه صفر نشود
        const catalogPrice = p[priceFieldFor(priceType)];
        if (auth.ctx.isAdmin || catalogPrice <= 0) {
          price = Math.min(price, auth.ctx.isAdmin ? 9_999_999_999 : MANUAL_PRICE_CAP);
        } else {
          price = catalogPrice;
        }
        // نام و حجم همیشه از دیتابیس — نه از کلاینت
        productName = p.name.slice(0, 120);
        volume = p.volume ?? volume;
      } else {
        // ردیف دستی: سقف قیمت برای جلوگیری از ثبت مبلغ نجومی
        price = Math.min(price, MANUAL_PRICE_CAP);
      }
      const lineTotal = Math.round(qty * price * (1 - discount / 100));
      rows.push({
        productId,
        productName,
        quantity: qty,
        volume,
        price,
        discount,
        offer: strOrNull(it.offer, 140),
        lineTotal,
        rowNumber: idx + 1,
      });
    }
    const totalAmount = rows.reduce((s: number, r: { lineTotal: number }) => s + r.lineTotal, 0);

    const order = await db.order.create({
      data: {
        orgId: auth.ctx.org ? auth.ctx.org.id : null,
        customerId,
        createdByUserId: auth.ctx.user.id,
        title: strOrNull(body.title, 120),
        priceType,
        note: strOrNull(body.note, 1000),
        // نحوه تسویه و سررسید (اختیاری) — مقادیر نامعتبر نادیده گرفته می‌شوند
        settlementType: settlementTypeOrNull(body.settlementType),
        dueDays: dueDaysOrNull(body.dueDays),
        totalAmount,
        items: { create: rows },
      },
      include: { items: true, customer: true },
    });
    return Response.json(order, { status: 201 });
  } catch (e) {
    // ممیزی v1.0.10 — رقابت هم‌زمان: مشتری بین بررسی و ثبت، حذف/آرشیو شده است
    // (FK حالا RESTRICT است) — پیام واضح به‌جای خطای 500؛ هیچ داده‌ای خراب نمی‌شود
    if ((e as { code?: string })?.code === "P2003") {
      return Response.json({ error: "مشتری یافت نشد یا هم‌اکنون حذف/آرشیو شده است" }, { status: 404 });
    }
    console.error("create order error", e);
    return Response.json({ error: "خطا در ثبت سفارش" }, { status: 500 });
  }
}
