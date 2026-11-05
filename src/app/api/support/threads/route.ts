import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  requireAuthSupport,
  isSupportSubject,
  supportBodyError,
  supportWriteAllowed,
  isValidClientRef,
  SUBJECT_LABELS,
} from "@/lib/support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * رشته‌های پشتیبانی مجموعه با سازنده — بخش چهارم سند طراحی (پشتیبانی داخلی)
 * -----------------------------------------------------------------------------
 * GET  : فهرست رشته‌های «مجموعهٔ خودِ کاربر» (orgId فقط از نشست سمت سرور)
 *        همراه آخرین پیام، وضعیت، نشان خوانده/نخوانده برای مجموعه
 * POST : ساخت رشته جدید (موضوع + متن پیام اول) — شناسه مجموعه «خودکار» پیوست می‌شود؛
 *        orgId هرگز از ورودی کلاینت خوانده نمی‌شود.
 *
 * این مسیر حتی در قفل لایسنس/تعلیق مجموعه باز است (الزام سند: فقط پشتیبانی باز می‌ماند).
 * امنیت: CSRF gate + احراز هویت کوکی + لیمیت پایدار DB (۱۰/دقیقه) + ۴۰۴-masking بین مجموعه‌ها
 */

/** GET — فهرست رشته‌های مجموعه */
export async function GET(req: NextRequest) {
  const auth = await requireAuthSupport(req);
  if ("error" in auth) return auth.error;
  const orgId = auth.ctx.org.id;
  const threads = await db.supportThread.findMany({
    where: { orgId },
    orderBy: { lastMessageAt: "desc" },
    take: 100,
    include: {
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
      _count: { select: { messages: true } },
    },
  });
  const unread = threads.filter((t) => t.unreadForOrg).length;
  return Response.json({
    unread,
    threads: threads.map((t) => ({
      id: t.id,
      subjectType: t.subjectType,
      subjectLabel: SUBJECT_LABELS[t.subjectType] || t.subjectType,
      status: t.status,
      unreadForOrg: t.unreadForOrg,
      messagesCount: t._count.messages,
      lastMessageAt: t.lastMessageAt,
      createdAt: t.createdAt,
      lastMessage: t.messages[0]
        ? { body: t.messages[0].body, senderSide: t.messages[0].senderSide, createdAt: t.messages[0].createdAt }
        : null,
    })),
  });
}

/** POST — ساخت رشته جدید + پیام اول (idempotent با clientRef — ضد درج تکراری آفلاین) */
export async function POST(req: NextRequest) {
  const auth = await requireAuthSupport(req);
  if ("error" in auth) return auth.error;
  const { ctx } = auth;
  if (!(await supportWriteAllowed(ctx.user.id))) {
    return Response.json(
      { error: "تلاش‌های زیاد — لطفاً کمی بعد دوباره تلاش کنید" },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const bodyErr = supportBodyError(body.body);
  if (bodyErr) return Response.json({ error: bodyErr }, { status: 400 });
  const subjectType = body.subjectType === undefined ? "GENERAL" : body.subjectType;
  if (!isSupportSubject(subjectType)) {
    return Response.json({ error: "موضوع گفتگو نامعتبر است" }, { status: 400 });
  }
  const text = (body.body as string).trim();
  const clientRef = body.clientRef === undefined || body.clientRef === null ? null : body.clientRef;
  if (clientRef !== null && !isValidClientRef(clientRef)) {
    return Response.json({ error: "شناسه پیام نامعتبر است" }, { status: 400 });
  }
  try {
    // ضد تکرار ارسال آفلاین: همان clientRef در همین مجموعه ⇒ همان رشته برمی‌گردد (هرگز دوباره درج نمی‌شود)
    if (clientRef) {
      const dup = await db.supportMessage.findFirst({
        where: { clientRef, thread: { orgId: ctx.org.id } },
        include: { thread: true },
      });
      if (dup) {
        return Response.json({
          ok: true,
          duplicate: true,
          thread: { id: dup.thread.id, subjectType: dup.thread.subjectType, status: dup.thread.status },
          messageId: dup.id,
        });
      }
    }
    const thread = await db.supportThread.create({
      data: {
        orgId: ctx.org.id, // فقط از نشست سمت سرور — هرگز از کلاینت
        subjectType,
        unreadForVendor: true,
        unreadForOrg: false,
        messages: {
          create: { senderSide: "ORG", senderName: ctx.user.name, body: text, clientRef },
        },
      },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    return Response.json({
      ok: true,
      duplicate: false,
      thread: {
        id: thread.id,
        subjectType: thread.subjectType,
        subjectLabel: SUBJECT_LABELS[thread.subjectType] || thread.subjectType,
        status: thread.status,
        messages: thread.messages.map((m) => ({
          id: m.id,
          senderSide: m.senderSide,
          senderName: m.senderName,
          body: m.body,
          createdAt: m.createdAt,
        })),
      },
    });
  } catch (e) {
    // رقابت هم‌زمان روی clientRef یکتا — پیام قبلاً ثبت شده (DUPLICATE امن)
    if ((e as { code?: string })?.code === "P2002" && clientRef) {
      const dup = await db.supportMessage.findFirst({
        where: { clientRef, thread: { orgId: ctx.org.id } },
        include: { thread: true },
      });
      if (dup) {
        return Response.json({
          ok: true,
          duplicate: true,
          thread: { id: dup.thread.id, subjectType: dup.thread.subjectType, status: dup.thread.status },
          messageId: dup.id,
        });
      }
    }
    console.error("support thread create error", (e as Error)?.name || "unknown");
    return Response.json({ error: "خطا در ثبت گفتگو" }, { status: 500 });
  }
}
