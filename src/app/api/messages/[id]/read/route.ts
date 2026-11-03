import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden } from "@/lib/auth";

type Params = { params: Promise<{ id: string }> };

/** ثبت خوانده‌شدن پیام — فقط ردیف گیرندهٔ خود کاربر (updateMany شرطی، ضد دسترسی به پیام دیگران) */
export async function POST(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const res = await db.messageRecipient.updateMany({
    where: { id, userId: auth.ctx.user.id, readAt: null },
    data: { readAt: new Date() },
  });
  if (res.count === 0) {
    return forbidden("این پیام برای شما نیست یا قبلاً خوانده شده است");
  }
  return Response.json({ ok: true });
}
