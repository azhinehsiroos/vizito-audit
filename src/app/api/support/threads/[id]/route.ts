import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  requireAuthSupport,
  supportBodyError,
  supportWriteAllowed,
  isValidClientRef,
  SUBJECT_LABELS,
} from "@/lib/support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * جزئیات یک رشته پشتیبانی مجموعه — بخش چهارم سند طراحی
 * -----------------------------------------------------------------------------
 * GET  : همه پیام‌های رشته (مجموعهٔ خود) + ثبت «خوانده‌شدن» سمت مجموعه
 * POST : ارسال پیام جدید در رشته {body, clientRef?} — idempotent با clientRef
 *        پیام مجموعه روی رشتهٔ بسته ⇒ بازگشایی خودکار به OPEN (رفتار محترمانه UX)
 *
 * امنیت: رشتهٔ مجموعهٔ دیگر = ۴۰۴ بدون افشا (همان الگوی 404-masking بین مجموعه‌ها)
 * این مسیر حتی در قفل لایسنس/تعلیق باز است (فقط پشتیبانی باز می‌ماند — الزام سند).
 */

type Params = { params: Promise<{ id: string }> };

/** رشته در محدوده مجموعهٔ کاربر — غیر از آن null (۴۰۴ بدون افشا) */
async function findInScope(id: string, orgId: string) {
  if (!id || id.length > 40) return null;
  const thread = await db.supportThread.findUnique({ where: { id } });
  if (!thread || thread.orgId !== orgId) return null;
  return thread;
}

export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireAuthSupport(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const thread = await findInScope(id, auth.ctx.org.id);
  if (!thread) return Response.json({ error: "گفتگو یافت نشد" }, { status: 404 });
  const messages = await db.supportMessage.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
  // بازکردن گفتگو توسط مجموعه = خوانده‌شدن پاسخ‌های سازنده
  if (thread.unreadForOrg) {
    await db.supportThread
      .update({ where: { id: thread.id }, data: { unreadForOrg: false } })
      .catch(() => {});
  }
  return Response.json({
    thread: {
      id: thread.id,
      subjectType: thread.subjectType,
      subjectLabel: SUBJECT_LABELS[thread.subjectType] || thread.subjectType,
      status: thread.status,
      unreadForOrg: false,
      lastMessageAt: thread.lastMessageAt,
      createdAt: thread.createdAt,
    },
    messages: messages.map((m) => ({
      id: m.id,
      senderSide: m.senderSide,
      senderName: m.senderName,
      body: m.body,
      createdAt: m.createdAt,
    })),
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  const auth = await requireAuthSupport(req);
  if ("error" in auth) return auth.error;
  const { ctx } = auth;
  if (!(await supportWriteAllowed(ctx.user.id))) {
    return Response.json(
      { error: "تلاش‌های زیاد — لطفاً کمی بعد دوباره تلاش کنید" },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }
  const { id } = await params;
  const thread = await findInScope(id, ctx.org.id);
  if (!thread) return Response.json({ error: "گفتگو یافت نشد" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const bodyErr = supportBodyError(body.body);
  if (bodyErr) return Response.json({ error: bodyErr }, { status: 400 });
  const text = (body.body as string).trim();
  const clientRef = body.clientRef === undefined || body.clientRef === null ? null : body.clientRef;
  if (clientRef !== null && !isValidClientRef(clientRef)) {
    return Response.json({ error: "شناسه پیام نامعتبر است" }, { status: 400 });
  }
  // ضد تکرار: همان clientRef در همین رشته ⇒ پیام موجود برمی‌گردد (DUPLICATE)
  if (clientRef) {
    const dup = await db.supportMessage.findUnique({
      where: { threadId_clientRef: { threadId: thread.id, clientRef } },
    });
    if (dup) {
      return Response.json({ ok: true, duplicate: true, messageId: dup.id, status: thread.status });
    }
  }
  try {
    const msg = await db.supportMessage.create({
      data: { threadId: thread.id, senderSide: "ORG", senderName: ctx.user.name, body: text, clientRef },
    });
    await db.supportThread.update({
      where: { id: thread.id },
      data: {
        status: "OPEN", // پیام جدید مجموعه روی گفتگوی بسته ⇒ بازگشایی خودکار
        unreadForVendor: true,
        unreadForOrg: false,
        lastMessageAt: new Date(),
      },
    });
    return Response.json({ ok: true, duplicate: false, messageId: msg.id, status: "OPEN", createdAt: msg.createdAt });
  } catch (e) {
    // رقابت هم‌زمان روی clientRef یکتا — پیام قبلاً ثبت شده (DUPLICATE امن)
    if ((e as { code?: string })?.code === "P2002" && clientRef) {
      const dup = await db.supportMessage.findUnique({
        where: { threadId_clientRef: { threadId: thread.id, clientRef } },
      });
      if (dup) return Response.json({ ok: true, duplicate: true, messageId: dup.id });
    }
    console.error("support message send error", (e as Error)?.name || "unknown");
    return Response.json({ error: "خطا در ارسال پیام" }, { status: 500 });
  }
}
