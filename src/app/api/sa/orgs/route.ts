import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSuper, logSaAccess } from "@/lib/sa";
import { strField, isFiniteDate } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * پنل مدیریت کل — مجموعه‌ها (فقط سازنده / SUPER_ADMIN) — کاملاً فقط-مشاهده
 * -----------------------------------------------------------------------------
 * GET بدون orgId : فهرست مجموعه‌ها
 *   ?q=        جست‌وجو در نام مجموعه / نام مدیر / موبایل مدیر
 *   ?status=   all | ACTIVE | SUSPENDED
 *   ?license=  all | TRIAL | ACTIVE | EXPIRED | SUSPENDED | NONE
 *   ?page=&pageSize=  صفحه‌بندی (سقف ۵۰ در صفحه)
 *   پاسخ: فهرست + جمع‌بندی کل (تعداد فعال/تعلیق/ترِیال/منقضی/بدون لایسنس)
 *
 * GET با orgId  : جزئیات فقط-مشاهده یک مجموعه — tab:
 *   overview  خلاصه: اطلاعات + شمارش‌ها + مدیر + آخرین رویدادهای لایسنس
 *   users     کاربران (فیلدهای امن — هش رمز هرگز سریالایز نمی‌شود)
 *   products  کالاها + گروه‌ها
 *   customers مشتریان (با شمارش سفارش)
 *   orders    آخرین سفارش‌ها
 *   reports   گزارش فروش مجموعه (کل/ماه + برترین‌ها)
 *
 * امنیت:
 *  - فقط سازنده؛ هر مشاهده در AdminAccessLog ثبت می‌شود
 *  - هیچ مسیر نوشتن روی داده تجاری مجموعه‌ها وجود ندارد (read-only الزام سند)
 *  - مجموعه ناموجود = ۴۰۴ بدون افشا
 */

type LicenseLike = { plan: string; expiresAt: Date | null; status: string } | null;

/** وضعیت مشتق‌شده لایسنس مجموعه — برای فیلتر و نشان UI */
function orgLicenseState(orgStatus: string, trialEndsAt: Date | null, lic: LicenseLike): string {
  if (orgStatus === "SUSPENDED") return "SUSPENDED";
  if (!lic) return trialEndsAt && trialEndsAt.getTime() > Date.now() ? "TRIAL" : "NONE";
  if (lic.status === "SUSPENDED") return "SUSPENDED";
  if (lic.plan === "PERM" || lic.expiresAt === null) return "ACTIVE";
  return lic.expiresAt.getTime() > Date.now() ? "ACTIVE" : "EXPIRED";
}

function licenseSummary(l: LicenseLike) {
  if (!l) return null;
  return { plan: l.plan, expiresAt: l.expiresAt ? l.expiresAt.toISOString() : null, status: l.status };
}

const VALID_TABS = ["overview", "users", "products", "customers", "orders", "reports"] as const;
type Tab = (typeof VALID_TABS)[number];

export async function GET(req: NextRequest) {
  const auth = await requireSuper(req);
  if ("error" in auth) return auth.error;
  const sp = req.nextUrl.searchParams;
  const orgId = strField(sp.get("orgId"), 40);
  try {
    // ── جزئیات یک مجموعه (فقط-مشاهده) ──
    if (orgId) {
      const tab: Tab = (VALID_TABS as readonly string[]).includes(sp.get("tab") || "")
        ? (sp.get("tab") as Tab)
        : "overview";
      const org = await db.org.findUnique({ where: { id: orgId }, include: { license: true } });
      if (!org) return Response.json({ error: "مجموعه یافت نشد" }, { status: 404 });
      const lic = org.license;
      const state = orgLicenseState(org.status, org.trialEndsAt, lic);

      if (tab === "overview") {
        const [admin, counts, events] = await Promise.all([
          db.user.findFirst({
            where: { orgId, role: { in: ["ORG_ADMIN", "ADMIN"] } },
            select: { id: true, name: true, mobile: true, company: true, createdAt: true },
          }),
          Promise.all([
            db.user.count({ where: { orgId } }),
            db.product.count({ where: { orgId } }),
            db.productGroup.count({ where: { orgId } }),
            db.customer.count({ where: { orgId } }),
            db.order.count({ where: { orgId } }),
            db.order.count({ where: { orgId, status: "CANCELED" } }),
            db.payment.count({ where: { orgId } }),
            db.order.aggregate({ where: { orgId, status: { not: "CANCELED" } }, _sum: { totalAmount: true } }),
            db.device.count({ where: { orgId } }),
          ]),
          db.licenseEvent.findMany({ where: { orgId }, orderBy: { createdAt: "desc" }, take: 5 }),
        ]);
        await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, orgId, "VIEW_ORG", req);
        return Response.json({
          org: {
            id: org.id,
            name: org.name,
            status: org.status,
            suspendedAt: org.suspendedAt,
            trialStartsAt: org.trialStartsAt,
            trialEndsAt: org.trialEndsAt,
            createdAt: org.createdAt,
          },
          license: licenseSummary(lic),
          licenseState: state,
          admin,
          counts: {
            users: counts[0],
            products: counts[1],
            groups: counts[2],
            customers: counts[3],
            orders: counts[4],
            canceledOrders: counts[5],
            payments: counts[6],
            totalSales: counts[7]._sum.totalAmount || 0,
            devices: counts[8],
          },
          events: events.map((e) => ({
            id: e.id,
            type: e.type,
            plan: e.plan,
            days: e.days,
            actorName: e.actorName,
            note: e.note,
            createdAt: e.createdAt,
          })),
        });
      }

      if (tab === "users") {
        const users = await db.user.findMany({
          where: { orgId },
          select: {
            id: true,
            name: true,
            mobile: true,
            company: true,
            role: true,
            kind: true,
            disabled: true,
            createdAt: true,
            grants: { select: { sections: true, expiresAt: true }, orderBy: { createdAt: "desc" }, take: 1 },
          },
          orderBy: { createdAt: "asc" },
          take: 200,
        });
        await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, orgId, "VIEW_USERS", req);
        // امنیت حریم خصوصی: فقط فیلدهای امن — هش رمز (password) هرگز در پاسخ نیست
        return Response.json({
          users: users.map((u) => ({
            id: u.id,
            name: u.name,
            mobile: u.mobile,
            company: u.company,
            role: u.role,
            kind: u.kind,
            disabled: u.disabled,
            createdAt: u.createdAt,
            grant: u.grants[0]
              ? { sections: u.grants[0].sections, expiresAt: u.grants[0].expiresAt }
              : null,
          })),
        });
      }

      if (tab === "products") {
        const [groups, products] = await Promise.all([
          db.productGroup.findMany({
            where: { orgId },
            select: { id: true, name: true, createdAt: true, _count: { select: { products: true } } },
            orderBy: { createdAt: "asc" },
            take: 100,
          }),
          db.product.findMany({
            where: { orgId },
            select: {
              id: true,
              name: true,
              groupId: true,
              volume: true,
              offer: true,
              pricePurchase: true,
              priceStore: true,
              pricePharmacy: true,
              priceSalon: true,
              discount: true,
              createdAt: true,
            },
            orderBy: { createdAt: "desc" },
            take: 300,
          }),
        ]);
        await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, orgId, "VIEW_PRODUCTS", req);
        return Response.json({
          groups: groups.map((g) => ({ id: g.id, name: g.name, createdAt: g.createdAt, productsCount: g._count.products })),
          products,
        });
      }

      if (tab === "customers") {
        const q = strField(sp.get("q"), 60);
        const showArchived = sp.get("archived") === "1";
        const scope = { orgId, archived: showArchived };
        const customers = await db.customer.findMany({
          where: {
            ...scope,
            ...(q
              ? {
                  AND: [
                    scope,
                    { OR: [{ name: { contains: q } }, { company: { contains: q } }, { phone: { contains: q } }] },
                  ],
                }
              : {}),
          },
          select: {
            id: true,
            name: true,
            company: true,
            phone: true,
            type: true,
            archived: true,
            createdBy: true,
            createdAt: true,
            _count: { select: { orders: true } },
          },
          orderBy: { createdAt: "desc" },
          take: 200,
        });
        // نام ثبت‌کننده‌ها — Customer رابطه createdByUser ندارد (ستون رشته‌ای)؛ یک کوئری گروهی
        const creatorIds = [...new Set(customers.map((c) => c.createdBy).filter((v): v is string => !!v))];
        const creators = creatorIds.length
          ? await db.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, name: true } })
          : [];
        const creatorMap = new Map(creators.map((u) => [u.id, u.name]));
        await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, orgId, "VIEW_CUSTOMERS", req);
        return Response.json({
          customers: customers.map((c) => ({
            id: c.id,
            name: c.name,
            company: c.company,
            phone: c.phone,
            type: c.type,
            archived: c.archived,
            createdAt: c.createdAt,
            createdBy: c.createdBy ? creatorMap.get(c.createdBy) ?? null : null,
            ordersCount: c._count.orders,
          })),
        });
      }

      if (tab === "orders") {
        const q = strField(sp.get("q"), 60);
        const orders = await db.order.findMany({
          where: {
            orgId,
            ...(q ? { customer: { OR: [{ name: { contains: q } }, { phone: { contains: q } }] } } : {}),
          },
          select: {
            id: true,
            title: true,
            status: true,
            priceType: true,
            totalAmount: true,
            settlementType: true,
            dueDays: true,
            createdOffline: true,
            needsReview: true,
            syncedAt: true,
            createdAt: true,
            customer: { select: { id: true, name: true, phone: true } },
            createdByUser: { select: { name: true } },
            _count: { select: { items: true } },
          },
          orderBy: { createdAt: "desc" },
          take: 100,
        });
        await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, orgId, "VIEW_ORDERS", req);
        return Response.json({
          orders: orders.map((o) => ({
            id: o.id,
            title: o.title,
            status: o.status,
            priceType: o.priceType,
            totalAmount: o.totalAmount,
            settlementType: o.settlementType,
            dueDays: o.dueDays,
            createdOffline: o.createdOffline,
            needsReview: o.needsReview,
            syncedAt: o.syncedAt,
            createdAt: o.createdAt,
            customer: o.customer,
            createdBy: o.createdByUser?.name ?? null,
            itemsCount: o._count.items,
          })),
        });
      }

      // tab === "reports" — گزارش فروش مجموعه (کل/ماه + برترین مشتریان/کالاها)
      const since = sp.get("since");
      const orders = await db.order.findMany({
        where: {
          orgId,
          status: { not: "CANCELED" },
          ...(isFiniteDate(since) ? { createdAt: { gte: new Date(since as string) } } : {}),
        },
        select: {
          id: true,
          totalAmount: true,
          createdAt: true,
          customerId: true,
          customer: { select: { name: true } },
          items: { select: { productName: true, quantity: true, lineTotal: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 1000,
      });
      const monthAgo = new Date();
      monthAgo.setMonth(monthAgo.getMonth() - 1);
      const totalSales = orders.reduce((s, o) => s + o.totalAmount, 0);
      const monthSales = orders.filter((o) => o.createdAt >= monthAgo).reduce((s, o) => s + o.totalAmount, 0);
      const byCustomer = new Map<string, { name: string; count: number; total: number }>();
      const byProduct = new Map<string, { qty: number; total: number }>();
      for (const o of orders) {
        const cur = byCustomer.get(o.customerId) || { name: o.customer.name, count: 0, total: 0 };
        cur.count += 1;
        cur.total += o.totalAmount;
        byCustomer.set(o.customerId, cur);
        for (const it of o.items) {
          const p = byProduct.get(it.productName) || { qty: 0, total: 0 };
          p.qty += it.quantity;
          p.total += it.lineTotal;
          byProduct.set(it.productName, p);
        }
      }
      await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, orgId, "VIEW_REPORTS", req);
      return Response.json({
        orderCount: orders.length,
        totalSales,
        monthSales,
        topCustomers: [...byCustomer.entries()]
          .sort((a, b) => b[1].total - a[1].total)
          .slice(0, 5)
          .map(([id, v]) => ({ customerId: id, name: v.name, count: v.count, total: v.total })),
        topProducts: [...byProduct.entries()]
          .sort((a, b) => b[1].total - a[1].total)
          .slice(0, 10)
          .map(([name, v]) => ({ name, qty: v.qty, total: v.total })),
      });
    }

    // ── فهرست مجموعه‌ها + جمع‌بندی ──
    const q = strField(sp.get("q"), 60);
    const statusF = sp.get("status") || "all";
    const licenseF = sp.get("license") || "all";
    const page = Math.max(1, Math.min(1000, Number(sp.get("page")) || 1));
    const pageSize = Math.max(1, Math.min(50, Number(sp.get("pageSize")) || 20));

    // جست‌وجوی مدیر بر اساس نام/موبایل — مجموعه‌های دارای آن مدیر
    let adminOrgIds: string[] | null = null;
    if (q) {
      const admins = await db.user.findMany({
        where: { role: { in: ["ORG_ADMIN", "ADMIN"] }, OR: [{ name: { contains: q } }, { mobile: { contains: q } }] },
        select: { orgId: true },
        take: 200,
      });
      adminOrgIds = admins.map((a) => a.orgId).filter((v): v is string => !!v);
    }

    const all = await db.org.findMany({
      include: { license: true },
      orderBy: { createdAt: "desc" },
      take: 1000,
    });
    const filtered = all.filter((o) => {
      if (statusF === "ACTIVE" || statusF === "SUSPENDED") {
        if (o.status !== statusF) return false;
      }
      const state = orgLicenseState(o.status, o.trialEndsAt, o.license);
      if (licenseF !== "all" && licenseF !== state) return false;
      if (q) {
        const nameHit = o.name.includes(q);
        const adminHit = adminOrgIds?.includes(o.id) ?? false;
        if (!nameHit && !adminHit) return false;
      }
      return true;
    });

    const summary = { total: filtered.length, active: 0, suspended: 0, trial: 0, expired: 0, noLicense: 0 };
    for (const o of filtered) {
      const state = orgLicenseState(o.status, o.trialEndsAt, o.license);
      if (state === "ACTIVE") summary.active += 1;
      else if (state === "SUSPENDED") summary.suspended += 1;
      else if (state === "TRIAL") summary.trial += 1;
      else if (state === "EXPIRED") summary.expired += 1;
      else summary.noLicense += 1;
    }

    const pageItems = filtered.slice((page - 1) * pageSize, page * pageSize);
    const ids = pageItems.map((o) => o.id);
    const [userCounts, admins] = await Promise.all([
      ids.length
        ? db.user.groupBy({ by: ["orgId"], _count: { _all: true }, where: { orgId: { in: ids } } })
        : Promise.resolve([] as { orgId: string | null; _count: { _all: number } }[]),
      ids.length
        ? db.user.findMany({
            where: { orgId: { in: ids }, role: { in: ["ORG_ADMIN", "ADMIN"] } },
            select: { orgId: true, name: true, mobile: true },
          })
        : Promise.resolve([] as { orgId: string | null; name: string; mobile: string }[]),
    ]);
    const countMap = new Map<string, number>(
      userCounts.filter((c) => c.orgId).map((c) => [c.orgId as string, c._count._all])
    );
    const adminMap = new Map<string, { name: string; mobile: string }>();
    for (const a of admins) if (a.orgId && !adminMap.has(a.orgId)) adminMap.set(a.orgId, { name: a.name, mobile: a.mobile });

    await logSaAccess(
      auth.ctx.user.id,
      auth.ctx.user.name,
      null,
      "VIEW_ORGS",
      req,
      `q=${q || "-"} status=${statusF} license=${licenseF}`
    );
    return Response.json({
      orgs: pageItems.map((o) => ({
        id: o.id,
        name: o.name,
        status: o.status,
        trialEndsAt: o.trialEndsAt,
        createdAt: o.createdAt,
        usersCount: countMap.get(o.id) ?? 0,
        admin: adminMap.get(o.id) ?? null,
        license: licenseSummary(o.license),
        licenseState: orgLicenseState(o.status, o.trialEndsAt, o.license),
      })),
      total: filtered.length,
      page,
      pageSize,
      summary,
    });
  } catch (e) {
    console.error("sa orgs error", e);
    return Response.json({ error: "خطا در دریافت اطلاعات مجموعه‌ها" }, { status: 500 });
  }
}
