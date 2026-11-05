import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getAuth, forbidden, canSeePurchasePrice, canSeeAllCustomers, csrfGate } from "@/lib/auth";
import { dbRateLimit } from "@/lib/rate-limit";
import { isValidClientRef } from "@/lib/support";
import { clampNum, strOrNull, strField, inWhitelist, VALID_PRICE_TYPES } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * همگام‌سازی دسته‌ای سفارش‌های آفلاین — بخش ۶.۱ سند طراحی SaaS
 * -----------------------------------------------------------------------------
 * POST /api/sync/orders   بدنه: { orders: [...] }  سقف دسته: ۵۰
 * پاسخ هر آیتم: { clientRef, orderId?, result: ACCEPTED | DUPLICATE | REJECTED(reason) }
 *
 * قواعد کلیدی سند:
 * - Idempotency: clientRef یکتای سراسری (@unique) — ارسال مجدد ⇒ DUPLICATE با
 *   شناسه موجود؛ هیچ‌گاه دوباره درج نمی‌شود. دستگاه‌های مستقل فقط درج می‌کنند.
 * - تعارض قیمت: قیمتِ آفلاین با قیمت فعلی کاتالوگ مقایسه می‌شود؛ تفاوت ⇒ سفارش
 *   پذیرفته و needsReview=true + اعلان به مدیران مجموعه (حذف/اصلاح خودکار ممنوع).
 * - بدون قفل لایسنس (بخش ۵٫۴: همگام‌سازی سفارش‌های آفلاین حتی پس از انقضا پذیرفته
 *   می‌شود؛ عملیات مدیریتی جدید جداگانه مسدود می‌ماند).
 * - orgId همیشه از نشست — هرگز از کلاینت. بدون $queryRaw.
 * - لیمیت پایدار DB: ۳۰ در دقیقه برای هر کاربر.
 */

const MAX_BATCH = 50;
const MAX_ITEMS = 200;
/** سقف قیمت ردیف دستی — هم‌تراز مسیر آنلاین /api/orders */
const MANUAL_PRICE_CAP = 1_000_000_000;

const VALID_SETTLEMENT_TYPES = ["CASH", "CHECK", "RECEIPT"] as const;

function settlementTypeOrNull(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return (VALID_SETTLEMENT_TYPES as readonly string[]).includes(s) ? s : null;
}

function dueDaysOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(3650, Math.max(1, Math.round(n)));
}

/** شناسه دستگاه از هدر — فقط شناسه است (نه اعتبارنامه)؛ نامعتبر ⇒ null (بی‌اثر) */
function deviceKeyOf(req: NextRequest): string | null {
  const raw = (req.headers.get("x-vizito-device") || "").trim();
  if (raw.length < 8 || raw.length > 64) return null;
  return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : null;
}

type SyncRow = {
  productId: string | null;
  productName: string;
  quantity: number;
  volume: string | null;
  price: number;
  discount: number;
  offer: string | null;
  lineTotal: number;
  rowNumber: number;
};

export async function POST(req: NextRequest) {
  // گیت CSRF — همان لایه‌های مسیرهای تغییردهنده دیگر (Content-Type + Origin/Referer)
  const csrf = csrfGate(req);
  if (csrf) return csrf;
  const ctx = await getAuth(req);
  if (!ctx) return Response.json({ error: "احراز هویت نشده است" }, { status: 401 });
  if (!ctx.org) return forbidden("همگام‌سازی فقط برای کاربران مجموعه‌دار است");
  if (!(await dbRateLimit(`sync:${ctx.user.id}`, 30, 60_000))) {
    return Response.json(
      { error: "تلاش‌های زیاد — لطفاً کمی بعد دوباره تلاش کنید" },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }
  const orgId = ctx.org.id;
  const deviceId = deviceKeyOf(req);
  const purchaseAllowed = canSeePurchasePrice(ctx);
  const isAdmin = ctx.isAdmin;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const rawOrders = Array.isArray(body.orders) ? body.orders : [];
  if (rawOrders.length === 0) {
    return Response.json({ error: "دسته سفارش خالی است" }, { status: 400 });
  }
  if (rawOrders.length > MAX_BATCH) {
    return Response.json({ error: `حداکثر ${MAX_BATCH} سفارش در هر درخواست` }, { status: 400 });
  }

  const results: {
    clientRef: string;
    orderId?: string;
    result: "ACCEPTED" | "DUPLICATE" | "REJECTED";
    reason?: string;
  }[] = [];

  for (const raw of rawOrders) {
    const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const clientRef = typeof o.clientRef === "string" ? o.clientRef : "";
    if (!isValidClientRef(clientRef)) {
      results.push({ clientRef: (clientRef as string).slice(0, 64) || "(نامعتبر)", result: "REJECTED", reason: "clientRef" });
      continue;
    }

    // ضد تکرار — اول پیش‌بینی ارزان، سپس گار P2002 برای رقابت هم‌زمان
    const dup = await db.order.findUnique({ where: { clientRef }, select: { id: true } });
    if (dup) {
      results.push({ clientRef, orderId: dup.id, result: "DUPLICATE" });
      continue;
    }

    // مشتری: باید داخل مجموعه خود کاربر باشد (۴۰۴-masking بین مجموعه‌ها)
    const customerId = strField(o.customerId, 40);
    const customer = customerId ? await db.customer.findUnique({ where: { id: customerId } }) : null;
    if (!customer || customer.orgId !== orgId) {
      results.push({ clientRef, result: "REJECTED", reason: "customer" });
      continue;
    }
    // محدوده دسترسی — همان قانون مسیر آنلاین: کاربر عادی فقط مشتری‌های خودش
    if (!canSeeAllCustomers(ctx) && customer.createdBy !== ctx.user.id) {
      results.push({ clientRef, result: "REJECTED", reason: "customer" });
      continue;
    }
    if (customer.archived) {
      results.push({ clientRef, result: "REJECTED", reason: "customer_archived" });
      continue;
    }

    let priceType = inWhitelist(o.priceType, VALID_PRICE_TYPES, "STORE");
    if (priceType === "PURCHASE" && !purchaseAllowed) priceType = "STORE";

    // ردیف‌ها — همان سقف‌های مسیر آنلاین؛ قیمت از اسنپ‌شات دستگاه (منجمد) می‌آید
    const rawItems = Array.isArray(o.items) ? o.items.slice(0, MAX_ITEMS) : [];
    const validItems = rawItems.filter(
      (it: unknown) =>
        typeof it === "object" &&
        it !== null &&
        strField((it as Record<string, unknown>).productName, 120) &&
        clampNum((it as Record<string, unknown>).quantity, 0, 1_000_000) > 0
    );
    if (validItems.length === 0) {
      results.push({ clientRef, result: "REJECTED", reason: "items" });
      continue;
    }

    // قیمت فعلی کاتالوگ برای کشف تعارض — فقط کالاهای همین مجموعه
    const productIds = [
      ...new Set(
        validItems
          .map((it: Record<string, unknown>) => strField(it.productId, 40))
          .filter((v: string | null): v is string => !!v)
      ),
    ];
    const productMap = new Map<string, {
      name: string; volume: string | null;
      priceStore: number; pricePharmacy: number; priceSalon: number; pricePurchase: number;
    }>();
    if (productIds.length > 0) {
      const found = await db.product.findMany({
        where: { id: { in: productIds }, orgId },
        select: { id: true, name: true, volume: true, priceStore: true, pricePharmacy: true, priceSalon: true, pricePurchase: true },
      });
      for (const p of found) productMap.set(p.id, p);
    }
    const priceFieldFor = (t: string): "priceStore" | "pricePharmacy" | "priceSalon" | "pricePurchase" =>
      t === "PHARMACY" ? "pricePharmacy" : t === "SALON" ? "priceSalon" : t === "PURCHASE" ? "pricePurchase" : "priceStore";

    const rows: SyncRow[] = [];
    let needsReview = false;
    for (let idx = 0; idx < validItems.length; idx++) {
      const it = validItems[idx] as Record<string, unknown>;
      const qty = clampNum(it.quantity, 0, 1_000_000);
      const discount = clampNum(it.discount, 0, 100);
      const productId = strField(it.productId, 40) || null;
      let price = clampNum(it.price, 0, 9_999_999_999);
      let productName = strField(it.productName, 120);
      let volume = strOrNull(it.volume, 40);
      const p = productId ? productMap.get(productId) : undefined;
      if (productId) {
        if (!p) {
          // کالای حذف‌شده از کاتالوگ پس از ثبت آفلاین — سفارش با قیمت منجمد پذیرفته
          // می‌شود ولی برای بررسی مدیر علامت می‌خورد (حذف خودکار ممنوع — D2)
          needsReview = true;
        } else {
          // تعارض قیمت: تفاوت قیمت منجمد دستگاه با کاتالوگ فعلی ⇒ needsReview
          const catalogPrice = p[priceFieldFor(priceType)];
          if (catalogPrice > 0 && Math.round(catalogPrice) !== Math.round(price)) needsReview = true;
          if (catalogPrice <= 0) price = Math.min(price, isAdmin ? 9_999_999_999 : MANUAL_PRICE_CAP);
          productName = p.name.slice(0, 120);
          volume = p.volume ?? volume;
        }
      } else {
        price = Math.min(price, isAdmin ? 9_999_999_999 : MANUAL_PRICE_CAP);
      }
      rows.push({
        productId,
        productName,
        quantity: qty,
        volume,
        price,
        discount,
        offer: strOrNull(it.offer, 140),
        lineTotal: Math.round(qty * price * (1 - discount / 100)),
        rowNumber: idx + 1,
      });
    }
    const totalAmount = rows.reduce((s, r) => s + r.lineTotal, 0);

    try {
      const order = await db.order.create({
        data: {
          orgId, // فقط از نشست سمت سرور
          customerId,
          createdByUserId: ctx.user.id,
          clientRef,
          deviceId,
          createdOffline: true,
          syncedAt: new Date(),
          needsReview,
          title: strOrNull(o.title, 120),
          priceType,
          note: strOrNull(o.note, 1000),
          settlementType: settlementTypeOrNull(o.settlementType),
          dueDays: dueDaysOrNull(o.dueDays),
          totalAmount,
          items: { create: rows },
        },
        select: { id: true },
      });
      results.push({ clientRef, orderId: order.id, result: "ACCEPTED" });
      // اعلان تعارض قیمت — به همه مدیران مجموعه (حذف/اصلاح خودکار ممنوع؛ فقط علامت)
      if (needsReview) {
        try {
          const admins = await db.user.findMany({
            where: { orgId, role: { in: ["ORG_ADMIN", "ADMIN"] } },
            select: { id: true },
          });
          if (admins.length > 0) {
            await db.notification.createMany({
              data: admins.map((a) => ({
                userId: a.id,
                type: "SYSTEM",
                title: "بررسی سفارش آفلاین",
                body: `سفارش آفلاین «${customer.name}» با قیمت متفاوت از کاتالوگ فعلی ثبت شده است — نیاز به بررسی دارد (هیچ تغییری خودکار اعمال نشده است).`,
              })),
            });
          }
        } catch (e) {
          console.error("sync needsReview notify error", e);
        }
      }
    } catch (e) {
      if ((e as { code?: string })?.code === "P2002") {
        const dup2 = await db.order.findUnique({ where: { clientRef }, select: { id: true } });
        if (dup2) {
          results.push({ clientRef, orderId: dup2.id, result: "DUPLICATE" });
          continue;
        }
      }
      console.error("sync order create error", (e as Error)?.name || "unknown");
      results.push({ clientRef, result: "REJECTED", reason: "server" });
    }
  }

  const accepted = results.filter((r) => r.result === "ACCEPTED").length;
  const duplicates = results.filter((r) => r.result === "DUPLICATE").length;
  const rejected = results.filter((r) => r.result === "REJECTED").length;
  return Response.json({ results, accepted, duplicates, rejected });
}
