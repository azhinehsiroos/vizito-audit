import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden } from "@/lib/auth";
import { isOwnerMobile } from "@/lib/license";
import { strField, strOrNull } from "@/lib/validate";
import { rateLimit, retryAfterSeconds, getClientIp } from "@/lib/rate-limit";

/**
 * پیام‌ها و اطلاع‌رسانی — فقط سازنده برنامه (مالک اصلی)
 * GET: تاریخچه پیام‌های ارسال‌شده + تعداد گیرندگان و خوانده‌شدن‌ها
 * POST: ارسال پیام به مخاطبان هدف
 */

const AUDIENCES = [
  "ALL", // همه کاربران
  "ADMINS", // مدیران (خریداران لایسنس روی همین سرور)
  "STAFF", // پرسنل شرکت‌ها
  "BUYERS", // خریداران لایسنس (طبق دفتر فروش)
  "SALE_EXPIRING", // لایسنس نزدیک به انقضا (۱۴ روز آینده)
  "SALE_EXPIRED", // لایسنس منقضی‌شده
  "SALE_GRACE", // در مهلت تمدید ۳۰ روزه
] as const;

const GRACE_MS = 30 * 86_400_000;
const EXPIRING_WINDOW_MS = 14 * 86_400_000;

function guardOwner(mobile: string, isAdmin: boolean): Response | null {
  if (!isAdmin || !isOwnerMobile(mobile)) {
    return forbidden("ارسال پیام مدیریتی فقط برای سازنده برنامه فعال است");
  }
  return null;
}

/** انقضای مؤثر یک فروش (دائمی = null) */
function saleExpiry(s: { durationDays: number; expiresAt: Date | null; createdAt: Date }): number | null {
  if (s.durationDays === 0) return null;
  return s.expiresAt ? s.expiresAt.getTime() : s.createdAt.getTime() + s.durationDays * 86_400_000;
}

/** حل گیرندگان بر اساس مخاطب — در لحظه ارسال snapshot می‌شود (تغییر بعدی حساب‌ها اثر گذشته ندارد) */
async function resolveRecipients(audience: string, userId: string | null): Promise<string[]> {
  const ownerMobiles = new Set(
    (process.env.OWNER_MOBILES || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  switch (audience) {
    case "ALL":
      return (await db.user.findMany({ select: { id: true } })).map((u) => u.id);
    case "ADMINS":
      return (await db.user.findMany({ where: { role: "ADMIN" }, select: { id: true } })).map((u) => u.id);
    case "STAFF":
      return (await db.user.findMany({ where: { kind: "STAFF", role: "USER" }, select: { id: true } })).map((u) => u.id);
    case "USER":
      if (!userId) return [];
      const one = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
      return one ? [one.id] : [];
    case "BUYERS":
    case "SALE_EXPIRING":
    case "SALE_EXPIRED":
    case "SALE_GRACE": {
      const sales = await db.licenseSale.findMany({
        select: { buyerMobile: true, durationDays: true, expiresAt: true, createdAt: true },
      });
      const now = Date.now();
      let mobiles: string[];
      if (audience === "BUYERS") {
        mobiles = sales.map((s) => s.buyerMobile);
      } else {
        mobiles = sales
          .filter((s) => {
            const e = saleExpiry(s);
            if (e === null) return false; // لایسنس دائمی خارج از چرخه انقضا است
            if (audience === "SALE_EXPIRING") return e > now && e - now <= EXPIRING_WINDOW_MS;
            if (audience === "SALE_EXPIRED") return e <= now;
            return e <= now && now < e + GRACE_MS; // SALE_GRACE
          })
          .map((s) => s.buyerMobile);
      }
      mobiles = [...new Set(mobiles)].filter((m) => !ownerMobiles.has(m));
      if (mobiles.length === 0) return [];
      const users = await db.user.findMany({ where: { mobile: { in: mobiles } }, select: { id: true } });
      return users.map((u) => u.id);
    }
    default:
      return [];
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const denied = guardOwner(auth.ctx.user.mobile, auth.ctx.isAdmin);
  if (denied) return denied;
  const messages = await db.message.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { recipients: { select: { readAt: true } } },
  });
  return Response.json({
    messages: messages.map((m) => ({
      id: m.id,
      audience: m.audience,
      title: m.title,
      body: m.body,
      important: m.important,
      senderName: m.senderName,
      createdAt: m.createdAt,
      deleted: !!m.deletedAt,
      recipientCount: m.recipients.length,
      readCount: m.recipients.filter((r) => r.readAt).length,
    })),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const denied = guardOwner(auth.ctx.user.mobile, auth.ctx.isAdmin);
  if (denied) return denied;
  // محدودیت نرخ سبک — ضد سوءاستفاده/اشتباه تکراری
  const ip = getClientIp(req);
  if (!rateLimit(`msg-send:${ip}`, 30, 60 * 60 * 1000)) {
    return Response.json(
      { error: "تعداد پیام‌های ارسالی زیاد است — یک ساعت دیگر تلاش کنید" },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds(`msg-send:${ip}`)) } }
    );
  }
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const audience = typeof body.audience === "string" ? body.audience : "";
    if (!(AUDIENCES as readonly string[]).includes(audience)) {
      return Response.json({ error: "مخاطب نامعتبر است" }, { status: 400 });
    }
    const userId = typeof body.userId === "string" ? body.userId : null;
    const title = strField(body.title, 120);
    const text = strOrNull(body.body, 4000);
    const important = body.important === true;
    if (!title) return Response.json({ error: "عنوان پیام الزامی است" }, { status: 400 });

    const recipients = [...new Set(await resolveRecipients(audience, userId))];
    if (recipients.length === 0) {
      return Response.json(
        { error: "گیرنده‌ای برای این مخاطب یافت نشد (مثلاً خریدار دفتر فروش هنوز حسابی روی این سرور ندارد)" },
        { status: 400 }
      );
    }
    const created = await db.$transaction(async (tx) => {
      const msg = await tx.message.create({
        data: {
          senderId: auth.ctx.user.id,
          senderName: auth.ctx.user.name,
          audience,
          title,
          body: text,
          important,
        },
      });
      await tx.messageRecipient.createMany({
        data: recipients.map((uid) => ({ messageId: msg.id, userId: uid })),
        // نکته: skipDuplicates در SQLite پشتیبانی نمی‌شود — messageId تازه است و تضادی ممکن نیست
      });
      return msg;
    });
    return Response.json({ ok: true, id: created.id, recipientCount: recipients.length }, { status: 201 });
  } catch (e) {
    console.error("admin message send error", e);
    return Response.json({ error: "خطا در ارسال پیام" }, { status: 500 });
  }
}
