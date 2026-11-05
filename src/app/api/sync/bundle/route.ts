import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getAuth, forbidden, canSeePurchasePrice, canSeeAllCustomers } from "@/lib/auth";
import { getOrgLockState } from "@/lib/license";
import { dbRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * اسنپ‌شات همگام‌سازی — بخش ۶.۱ سند طراحی SaaS
 * -----------------------------------------------------------------------------
 * GET /api/sync/bundle?since=ISO
 * - فقط «مجموعه خود کاربر» (orgId فقط از نشست سمت سرور — هرگز از کلاینت)
 * - بدون قفل لایسنس (الزام بخش ۵٫۴: همگام‌سازی حتی پس از انقضا پذیرفته می‌شود؛
 *   داده هرگز حذف/قفل‌نشدنی نیست — D2)
 * - محتوا: مشتریان فعال، گروه‌ها و کالاها (با رعایت مجوز قیمت خرید)، نام/لوگوی
 *   مجموعه، وضعیت لایسنس/ترِیال — همان ساختاری که ویوها در اسنپ‌شات محلی می‌خوانند
 * - لیمیت پایدار DB: ۳۰ در دقیقه برای هر کاربر (بخش دهم سند)
 */

export async function GET(req: NextRequest) {
  const ctx = await getAuth(req);
  if (!ctx) return Response.json({ error: "احراز هویت نشده است" }, { status: 401 });
  // همگام‌سازی تجاری مجموعه‌محور است — حساب بدون مجموعه (سازنده/قدیمی) باندل نمی‌گیرد
  if (!ctx.org) return forbidden("همگام‌سازی فقط برای کاربران مجموعه‌دار است");
  // لیمیت پایدار DB — ۳۰/دقیقه (سند بخش دهم)
  if (!(await dbRateLimit(`sync:${ctx.user.id}`, 30, 60_000))) {
    return Response.json(
      { error: "تلاش‌های زیاد — لطفاً کمی بعد دوباره تلاش کنید" },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }
  const orgId = ctx.org.id;
  const syncedAt = new Date().toISOString();

  // محدوده مشتریان — دقیقاً همان قانون فهرست آنلاین: مدیر/دارای all_customers ←
  // همه مجموعه؛ بقیه فقط مشتری‌های خودشان (اسنپ‌شات آفلاین هرگز از مرز دسترسی عبور نمی‌کند)
  const customerScope = canSeeAllCustomers(ctx)
    ? { orgId, archived: false }
    : { orgId, archived: false, createdBy: ctx.user.id };

  const [org, customers, groups, lock] = await Promise.all([
    db.org.findUnique({ where: { id: orgId }, select: { id: true, name: true, logo: true, status: true } }),
    db.customer.findMany({
      where: customerScope,
      select: {
        id: true, name: true, company: true, phone: true, address: true,
        nationalId: true, type: true, archived: true, createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    db.productGroup.findMany({
      where: { orgId },
      include: { products: { orderBy: { createdAt: "desc" } } },
      orderBy: { createdAt: "desc" },
    }),
    getOrgLockState({ id: orgId, status: ctx.org.status, trialEndsAt: ctx.org.trialEndsAt }),
  ]);
  if (!org) return forbidden("مجموعه یافت نشد");

  // قیمت خرید فقط برای دارای مجوز — همان قانون کاتالوگ (هرگز از مرز مجوز عبور نمی‌کند)
  const allowed = canSeePurchasePrice(ctx);
  const safeGroups = groups.map((g) => ({
    id: g.id,
    name: g.name,
    createdAt: g.createdAt,
    products: g.products.map((p) => ({
      id: p.id,
      groupId: p.groupId,
      name: p.name,
      image: p.image,
      description: p.description,
      volume: p.volume,
      offer: p.offer,
      pricePurchase: allowed ? p.pricePurchase : null,
      priceStore: p.priceStore,
      pricePharmacy: p.pricePharmacy,
      priceSalon: p.priceSalon,
      discount: p.discount,
      minOrder: p.minOrder,
      createdAt: p.createdAt,
    })),
  }));

  return Response.json({
    syncedAt,
    org: { id: org.id, name: org.name, logo: org.logo, status: org.status },
    license: {
      phase: lock.locked ? lock.phase : "ACTIVE",
      locked: lock.locked,
      trial: lock.trial,
      permanent: lock.permanent,
      suspended: lock.suspended,
      expiresAt: lock.expiresAt,
      daysLeft: lock.daysLeft,
      trialEndsAt: lock.trialEndsAt,
      graceUntil: lock.graceUntil,
      graceDaysLeft: lock.graceDaysLeft,
    },
    customers,
    groups: safeGroups,
  });
}
