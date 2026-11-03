import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, canSeeAllCustomers, type AuthContext } from "@/lib/auth";
import { strField, strOrNull, clampNum, isFiniteDate } from "@/lib/validate";

/** انواع تسویه مجاز: نقد / چک پای‌بار / رسید */
const VALID_PAYMENT_TYPES = ["CASH", "CHECK", "RECEIPT"] as const;

/** محدودیت دسترسی به یک مشتری: مدیر/دارای all_customers ← همه؛ بقیه فقط مشتری‌های خودشان */
async function customerInScope(customerId: string, ctx: AuthContext) {
  const customer = await db.customer.findUnique({ where: { id: customerId } });
  if (!customer) return null;
  if (!canSeeAllCustomers(ctx) && customer.createdBy !== ctx.user.id) return null;
  return customer;
}

/** GET تسویه‌های یک مشتری + خلاصه حساب (جمع سفارش‌ها، جمع پرداخت‌ها، مانده) */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, "orders"); // تسویه بخشی از چرخه فروش است + محدوده دسترسی از محدوده مشتری پیروی می‌کند
  if ("error" in auth) return auth.error;
  const customerId = strField(req.nextUrl.searchParams.get("customerId"), 40);
  if (!customerId) {
    return Response.json({ error: "شناسه مشتری الزامی است" }, { status: 400 });
  }
  const customer = await customerInScope(customerId, auth.ctx);
  if (!customer) return Response.json({ error: "مشتری یافت نشد" }, { status: 404 });

  const [payments, ordersSum, paidSum, discountSum] = await Promise.all([
    db.payment.findMany({
      where: { customerId },
      include: { createdByUser: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
    // مانده حساب فقط بر اساس فاکتورهای نهایی محاسبه می‌شود
    db.order.aggregate({
      _sum: { totalAmount: true },
      where: { customerId, status: "FINAL" },
    }),
    db.payment.aggregate({
      _sum: { amount: true },
      where: { customerId },
    }),
    db.payment.aggregate({
      _sum: { discountAmount: true },
      where: { customerId },
    }),
  ]);

  const totalOrders = ordersSum._sum.totalAmount ?? 0;
  // تخفیف نقدی هم بخشی از تسویه حساب است (مانده را کم می‌کند ولی نقد دریافت نشده)
  const totalPaid = (paidSum._sum.amount ?? 0) + (discountSum._sum.discountAmount ?? 0);

  return Response.json({
    payments,
    summary: {
      totalOrders,
      totalPaid,
      balance: totalOrders - totalPaid,
    },
  });
}

/** ثبت تسویه حساب مشتری — نقد / چک / رسید */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, "orders");
  if ("error" in auth) return auth.error;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const customerId = strField(body.customerId, 40);
    if (!customerId) return Response.json({ error: "انتخاب مشتری الزامی است" }, { status: 400 });
    const customer = await customerInScope(customerId, auth.ctx);
    if (!customer) return Response.json({ error: "مشتری یافت نشد" }, { status: 404 });

    // نوع تسویه الزامی است و فقط از لیست مجاز
    const type = strField(body.type, 20);
    if (!(VALID_PAYMENT_TYPES as readonly string[]).includes(type)) {
      return Response.json({ error: "نوع تسویه معتبر نیست (نقدی/چک/رسید)" }, { status: 400 });
    }

    const amount = clampNum(body.amount, 0, 9_999_999_999);
    if (amount <= 0) return Response.json({ error: "مبلغ تسویه باید بزرگ‌تر از صفر باشد" }, { status: 400 });

    // تخفیف نقدی: درصد + مبلغ بخشیده‌شده — فقط برای پرداخت نقدی معنا دارد
    const discountPercent =
      type === "CASH" ? Math.min(100, Math.max(0, clampNum(body.discountPercent, 0, 100))) : 0;
    const discountAmount =
      type === "CASH" ? Math.min(9_999_999_999, Math.max(0, clampNum(body.discountAmount, 0, 9_999_999_999))) : 0;

    // تاریخ‌ها با همان الگوی اعتبارسنجی سفارش‌ها
    const paidAt = isFiniteDate(body.paidAt) ? new Date(body.paidAt as string) : null;
    const settleAt = isFiniteDate(body.settleAt) ? new Date(body.settleAt as string) : null;

    // فاکتور اختیاری — در صورت ارسال باید متعلق به همین مشتری باشد
    const orderId = strField(body.orderId, 40) || null;
    if (orderId) {
      const order = await db.order.findUnique({ where: { id: orderId } });
      if (!order || order.customerId !== customerId) {
        return Response.json({ error: "فاکتور انتخاب‌شده متعلق به این مشتری نیست" }, { status: 400 });
      }
    }

    const payment = await db.payment.create({
      data: {
        customerId,
        orderId,
        type,
        amount,
        discountPercent,
        discountAmount,
        paidAt,
        trackingNumber: strOrNull(body.trackingNumber, 60),
        bankName: strOrNull(body.bankName, 60),
        checkNumber: strOrNull(body.checkNumber, 40),
        sayadiNumber: strOrNull(body.sayadiNumber, 30),
        settleAt,
        note: strOrNull(body.note, 300),
        createdByUserId: auth.ctx.user.id,
      },
      include: { createdByUser: { select: { name: true } } },
    });
    return Response.json(payment, { status: 201 });
  } catch (e) {
    // ممیزی v1.0.10 — رقابت هم‌زمان: مشتری بین بررسی و ثبت، حذف/آرشیو شده است
    // (FK حالا RESTRICT است) — پیام واضح به‌جای خطای 500؛ هیچ داده‌ای خراب نمی‌شود
    if ((e as { code?: string })?.code === "P2003") {
      return Response.json({ error: "مشتری یافت نشد یا هم‌اکنون حذف/آرشیو شده است" }, { status: 404 });
    }
    console.error("create payment error", e);
    return Response.json({ error: "خطا در ثبت تسویه" }, { status: 500 });
  }
}
