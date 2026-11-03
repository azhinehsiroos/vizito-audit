import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, canSeeAllCustomers } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, "reports");
  if ("error" in auth) return auth.error;
  try {
    // آمار هر کاربر فقط در محدوده دسترسی خودش: مدیر/دارای all_customers ← همه؛ بقیه فقط مشتری‌ها و سفارش‌های خودشان
    const allAccess = canSeeAllCustomers(auth.ctx);
    const customerWhere = allAccess ? {} : { createdBy: auth.ctx.user.id };
    const orderWhere = allAccess
      ? {}
      : { OR: [{ customer: { createdBy: auth.ctx.user.id } }, { createdByUserId: auth.ctx.user.id }] };

    const [customerCount, productCount, groupCount, orders, orderCount] = await Promise.all([
      db.customer.count({ where: customerWhere }),
      db.product.count(),
      db.productGroup.count(),
      db.order.findMany({
        where: orderWhere,
        select: { id: true, totalAmount: true, createdAt: true, customerId: true, items: true },
        orderBy: { createdAt: "desc" },
        take: 500,
      }),
      db.order.count({ where: orderWhere }),
    ]);

    const totalSales = orders.reduce((s, o) => s + o.totalAmount, 0);
    const monthAgo = new Date();
    monthAgo.setMonth(monthAgo.getMonth() - 1);
    const monthSales = orders
      .filter((o) => o.createdAt >= monthAgo)
      .reduce((s, o) => s + o.totalAmount, 0);

    const byCustomer = new Map<string, { count: number; total: number }>();
    for (const o of orders) {
      const cur = byCustomer.get(o.customerId) || { count: 0, total: 0 };
      cur.count += 1;
      cur.total += o.totalAmount;
      byCustomer.set(o.customerId, cur);
    }
    const topCustomers = [...byCustomer.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 5)
      .map(([customerId, v]) => ({ customerId, ...v }));

    const lastOrders = orders.slice(0, 5).map((o) => ({
      id: o.id,
      totalAmount: o.totalAmount,
      createdAt: o.createdAt,
      customerId: o.customerId,
      itemCount: o.items.length,
    }));

    return Response.json({
      customerCount,
      productCount,
      groupCount,
      orderCount,
      totalSales,
      monthSales,
      topCustomers,
      lastOrders,
    });
  } catch (e) {
    console.error("summary error", e);
    return Response.json({ error: "خطا در دریافت آمار" }, { status: 500 });
  }
}
