import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, canSeeAllCustomers, canSeePurchasePrice, forbidden } from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

/**
 * حذف تسویه — فقط مدیر یا ثبت‌کننده، و مشتری باید داخل محدوده دسترسی باشد.
 * تسویه غایب یا خارج از محدوده ← ۴۰۴ (بدون افشای وجود رکورد)
 */
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, "orders");
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const payment = await db.payment.findUnique({
    where: { id },
    include: { customer: true, order: { select: { priceType: true } } },
  });
  if (!payment) return Response.json({ error: "تسویه یافت نشد" }, { status: 404 });
  if (!canSeeAllCustomers(auth.ctx) && payment.customer.createdBy !== auth.ctx.user.id) {
    return Response.json({ error: "تسویه یافت نشد" }, { status: 404 });
  }
  // ممیزی امنیتی — تسویه متصل به فاکتور خرید برای فاقد مجوز purchase_price نامرئی است
  // (۴۰۴ بدون افشای وجود رکورد — هم‌سو با رفتار نامرئی فاکتور خرید)
  if (payment.order?.priceType === "PURCHASE" && !canSeePurchasePrice(auth.ctx)) {
    return Response.json({ error: "تسویه یافت نشد" }, { status: 404 });
  }
  if (!auth.ctx.isAdmin && payment.createdByUserId !== auth.ctx.user.id) {
    return forbidden("فقط مدیر یا ثبت‌کننده اجازه حذف این تسویه را دارد");
  }
  try {
    await db.payment.delete({ where: { id } });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "خطا در حذف تسویه" }, { status: 500 });
  }
}
