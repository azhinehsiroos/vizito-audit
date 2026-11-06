import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden } from "@/lib/auth";
import { isOwnerMobile } from "@/lib/license";

type Params = { params: Promise<{ id: string }> };

function guardOwner(mobile: string, isAdmin: boolean): Response | null {
  if (!isAdmin || !isOwnerMobile(mobile)) {
    return forbidden("این بخش فقط برای سازنده برنامه فعال است");
  }
  return null;
}

/** جزئیات پیام: فهرست گیرندگان + وضعیت خوانده‌شدن — فقط سازنده برنامه */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const denied = guardOwner(auth.ctx.user.mobile, auth.ctx.isAdmin);
  if (denied) return denied;
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
}

/** حذف پیام (نرم) — از صندوق کاربران پنهان می‌شود ولی در تاریخچه مالک با نشان «حذف‌شده» می‌ماند */
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const denied = guardOwner(auth.ctx.user.mobile, auth.ctx.isAdmin);
  if (denied) return denied;
  const { id } = await params;
  const existing = await db.message.findUnique({ where: { id } });
  if (!existing) return Response.json({ error: "پیام یافت نشد" }, { status: 404 });
  await db.message.update({ where: { id }, data: { deletedAt: new Date() } });
  return Response.json({ ok: true });
}
