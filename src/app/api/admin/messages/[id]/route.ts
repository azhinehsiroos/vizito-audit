import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { requireOwnerContext, adminAccessLogData, logSaAccess } from "@/lib/sa";

type Params = { params: Promise<{ id: string }> };

// M9: گارد یکپارچه مالک — منبع واحد در sa.ts

/** جزئیات پیام: فهرست گیرندگان + وضعیت خوانده‌شدن — فقط سازنده برنامه */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const denied = requireOwnerContext(auth.ctx);
  if (denied) return denied;
  try {
    const { id } = await params;
    const msg = await db.message.findUnique({
      where: { id },
      include: {
        recipients: {
          include: { user: { select: { id: true, name: true, mobile: true, role: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!msg) return Response.json({ error: "پیام یافت نشد" }, { status: 404 });
    // M3: مشاهده جزئیات گیرندگان (شامل موبایل کاربران) — حسابرسی fail-closed
    await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, null, "VIEW_MASS_MESSAGE_DETAIL", req, `msg=${id.slice(0, 12)}`);
    return Response.json({
      message: {
        id: msg.id,
        audience: msg.audience,
        title: msg.title,
        body: msg.body,
        important: msg.important,
        senderName: msg.senderName,
        createdAt: msg.createdAt,
        deleted: !!msg.deletedAt,
      },
      recipients: msg.recipients.map((r) => ({
        userId: r.user.id,
        name: r.user.name,
        mobile: r.user.mobile,
        role: r.user.role,
        readAt: r.readAt,
      })),
    });
  } catch (e) {
    console.error("admin message detail error", e);
    return Response.json({ error: "خطا در دریافت پیام" }, { status: 500 });
  }
}

/** حذف پیام (نرم) — از صندوق کاربران پنهان می‌شود ولی در تاریخچه مالک با نشان «حذف‌شده» می‌ماند */
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const denied = requireOwnerContext(auth.ctx);
  if (denied) return denied;
  try {
    const { id } = await params;
    const existing = await db.message.findUnique({ where: { id } });
    if (!existing) return Response.json({ error: "پیام یافت نشد" }, { status: 404 });
    await db.$transaction(async (tx) => {
      await tx.message.update({ where: { id }, data: { deletedAt: new Date() } });
      // M3: حذف پیام گروهی — حسابرسی تراکنشی (fail-closed)
      await tx.adminAccessLog.create({
        data: adminAccessLogData(auth.ctx.user.id, auth.ctx.user.name, null, "DELETE_MASS_MESSAGE", req, `msg=${id.slice(0, 12)}`),
      });
    });
    return Response.json({ ok: true });
  } catch (e) {
    console.error("admin message delete error", e);
    return Response.json({ error: "خطا در حذف پیام" }, { status: 500 });
  }
}
