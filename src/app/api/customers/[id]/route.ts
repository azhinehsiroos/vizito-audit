import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, canSeeAllCustomers, type AuthContext } from "@/lib/auth";
import { strField, strOrNull, inWhitelist, VALID_CUSTOMER_TYPES } from "@/lib/validate";

type Params = { params: Promise<{ id: string }> };

/**
 * بررسی محدوده دسترسی مشتری:
 * مدیر و دارای مجوز all_customers به همه مشتری‌ها دسترسی دارند؛
 * کاربر عادی فقط به مشتری‌هایی که خودش ثبت کرده (در غیر این صورت ۴۰۴ — بدون افشای وجود رکورد)
 */
async function findInScope(id: string, ctx: AuthContext) {
  const customer = await db.customer.findUnique({ where: { id } });
  if (!customer) return null;
  if (!canSeeAllCustomers(ctx) && customer.createdBy !== ctx.user.id) return null;
  return customer;
}

export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, "customers");
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const inScope = await findInScope(id, auth.ctx);
  if (!inScope) return Response.json({ error: "مشتری یافت نشد" }, { status: 404 });
  const customer = await db.customer.findUnique({
    where: { id },
    include: {
      orders: {
        orderBy: { createdAt: "desc" },
        include: { items: true },
      },
    },
  });
  if (!customer) return Response.json({ error: "مشتری یافت نشد" }, { status: 404 });
  return Response.json(customer);
}

export async function PUT(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, "customers");
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const inScope = await findInScope(id, auth.ctx);
  if (!inScope) return Response.json({ error: "مشتری یافت نشد" }, { status: 404 });
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = strField(body.name, 100);
    if (!name) return Response.json({ error: "نام مشتری الزامی است" }, { status: 400 });
    const customer = await db.customer.update({
      where: { id },
      data: {
        name,
        company: strOrNull(body.company, 100),
        phone: strField(body.phone, 20),
        address: strOrNull(body.address, 400),
        nationalId: strOrNull(body.nationalId, 20),
        type: inWhitelist(body.type, VALID_CUSTOMER_TYPES, "STORE"),
      },
    });
    return Response.json(customer);
  } catch (e) {
    console.error("update customer error", e);
    return Response.json({ error: "خطا در ویرایش مشتری" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, "customers");
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const inScope = await findInScope(id, auth.ctx);
  if (!inScope) return Response.json({ error: "مشتری یافت نشد" }, { status: 404 });
  try {
    // ممیزی v1.0.9 — جلوگیری از حذف ناخواسته سوابق:
    // مشتریِ دارای سفارش یا پرداخت «هرگز» سخت‌حذف نمی‌شود (حذف آبشاری سفارش‌ها/پرداخت‌ها
    // سوابق مالی را نابود می‌کرد) — به‌جای آن آرشیو نرم می‌شود و قابل بازگردانی است.
    // فقط مشتریِ بدون هیچ سابقه‌ای به‌صورت دائمی حذف می‌شود.
    const [orderCount, paymentCount] = await Promise.all([
      db.order.count({ where: { customerId: id } }),
      db.payment.count({ where: { customerId: id } }),
    ]);
    if (orderCount > 0 || paymentCount > 0) {
      const customer = await db.customer.update({
        where: { id },
        data: { archived: true, archivedAt: new Date() },
      });
      return Response.json({ ok: true, archived: true, customer });
    }
    await db.customer.delete({ where: { id } });
    return Response.json({ ok: true, archived: false });
  } catch {
    return Response.json({ error: "خطا در حذف مشتری" }, { status: 500 });
  }
}

/** بازگردانی مشتری آرشیوشده (PATCH — فقط تغییر وضعیت آرشیو، بدون دست‌زدن به داده‌ها) */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, "customers");
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const inScope = await findInScope(id, auth.ctx);
  if (!inScope) return Response.json({ error: "مشتری یافت نشد" }, { status: 404 });
  try {
    const body = (await req.json().catch(() => ({}))) as { archived?: unknown };
    const archived = body.archived === true;
    const customer = await db.customer.update({
      where: { id },
      data: archived ? { archived: true, archivedAt: new Date() } : { archived: false, archivedAt: null },
    });
    return Response.json({ ok: true, customer });
  } catch {
    return Response.json({ error: "خطا در تغییر وضعیت آرشیو مشتری" }, { status: 500 });
  }
}
