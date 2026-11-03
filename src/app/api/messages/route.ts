import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

/**
 * صندوق پیام کاربر — هر کاربر فقط پیام‌های خودش را می‌بیند (سمت سرور فیلتر می‌شود)
 * پیام‌های حذف‌شده توسط مالک (deletedAt) نمایش داده نمی‌شوند
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const recips = await db.messageRecipient.findMany({
    where: { userId: auth.ctx.user.id, message: { deletedAt: null } },
    include: {
      message: {
        select: { id: true, title: true, body: true, important: true, senderName: true, createdAt: true },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const messages = recips.map((r) => ({
    id: r.id, // شناسه ردیف گیرنده — برای ثبت خوانده‌شدن
    title: r.message.title,
    body: r.message.body,
    important: r.message.important,
    senderName: r.message.senderName,
    createdAt: r.message.createdAt,
    readAt: r.readAt,
  }));
  const unread = messages.filter((m) => !m.readAt).length;
  return Response.json({ messages, unread });
}
