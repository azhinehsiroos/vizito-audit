import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, canSeeAllCustomers } from "@/lib/auth";
import { strField, strOrNull, inWhitelist, VALID_CUSTOMER_TYPES } from "@/lib/validate";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, "customers");
  if ("error" in auth) return auth.error;
  const sp = req.nextUrl.searchParams;
  const q = sp.get("q")?.trim().slice(0, 60) || "";
  // ممیزی v1.0.9 — فیلتر آرشیو: پیش‌فرض فقط مشتری‌های فعال؛ ?archived=1 فقط آرشیوشده‌ها
  // (سوابق مشتری آرشیوشده در سفارش‌ها/پرداخت‌ها/گزارش‌ها دست‌نخورده می‌ماند)
  const showArchived = sp.get("archived") === "1";
  // محدودسازی دسترسی: مدیر و دارای مجوز all_customers ← همه مشتری‌ها؛ بقیه فقط مشتری‌های خودشان
  const allAccess = canSeeAllCustomers(auth.ctx);
  const scopeWhere = { ...(allAccess ? {} : { createdBy: auth.ctx.user.id }), archived: showArchived };
  const customers = await db.customer.findMany({
    where: {
      ...scopeWhere,
      ...(q
        ? {
            AND: [
              scopeWhere,
              {
                OR: [
                  { name: { contains: q } },
                  { company: { contains: q } },
                  { phone: { contains: q } },
                  { nationalId: { contains: q } },
                ],
              },
            ],
          }
        : {}),
    },
    include: { _count: { select: { orders: true } } },
    orderBy: { createdAt: "desc" },
  });
  return Response.json(customers);
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, "customers");
  if ("error" in auth) return auth.error;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = strField(body.name, 100);
    const phone = strField(body.phone, 20);
    if (!name) return Response.json({ error: "نام مشتری الزامی است" }, { status: 400 });
    if (!phone) return Response.json({ error: "تلفن مشتری الزامی است" }, { status: 400 });

    const customer = await db.customer.create({
      data: {
        name,
        company: strOrNull(body.company, 100),
        phone,
        address: strOrNull(body.address, 400),
        nationalId: strOrNull(body.nationalId, 20),
        type: inWhitelist(body.type, VALID_CUSTOMER_TYPES, "STORE"),
        // مالک مشتری = ثبت‌کننده؛ مدیر همه را می‌بیند و کاربر عادی فقط مالکیت خودش را
        createdBy: auth.ctx.user.id,
      },
    });
    return Response.json(customer, { status: 201 });
  } catch (e) {
    console.error("create customer error", e);
    return Response.json({ error: "خطا در ثبت مشتری" }, { status: 500 });
  }
}
