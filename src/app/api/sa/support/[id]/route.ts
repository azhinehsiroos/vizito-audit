import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSuper, logSaAccess } from "@/lib/sa";
import { strField } from "@/lib/validate";
import { supportBodyError, supportWriteAllowed, isValidClientRef, SUBJECT_LABELS } from "@/lib/support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * جزئیات/عملیات یک رشته پشتیبانی — فقط سازنده (SUPER_ADMIN)
 * -----------------------------------------------------------------------------
 * GET  : همه پیام‌ها + اطلاعات مجموعه/مدیر + ثبت «خوانده‌شدن» سمت سازنده
 *        + حسابرسی VIEW_SUPPORT_THREAD
 * POST : عملیات بر اساس action:
 *  - reply  : پاسخ سازنده {body, clientRef?} ⇒ وضعیت ANSWERED + unreadForOrg
 *  - status : تعیین وضعیت {status: OPEN | ANSWERED | CLOSED} — بستن/بازکردن گفتگو
 *
 * امنیت: requireSuper + حسابرسی کامل هر عملیات + لیمیت پایدار DB + سقف ۴۰۰۰ کاراکتر
 * پاسخ سازنده حتی وقتی مجموعه تعلیق/منقضی است برایش نمایش داده می‌شود (فقط پشتیبانی باز است).
 */

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireSuper(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!id || id.length > 40) return Response.json({ error: "گفتگو یافت نشد" }, { status: 404 });
  const thread = await db.supportThread.findUnique({
    where: { id },
    include: {
      org: { select: { id: true, name: true, status: true, trialEndsAt: true } },
    },
  });
  if (!thread) return Response.json({ error: "گفتگو یافت نشد" }, { status: 404 });
  const [messages, admin] = await Promise.all([
    db.supportMessage.findMany({ where: { threadId: thread.id }, orderBy: { createdAt: "asc" }, take: 500 }),
    db.user.findFirst({
      where: { orgId: thread.orgId, role: { in: ["ORG_ADMIN", "ADMIN"] } },
      select: { name: true, mobile: true },
    }),
  ]);
  if (thread.unreadForVendor) {
    await db.supportThread
      .update({ where: { id: thread.id }, data: { unreadForVendor: false } })
      .catch(() => {});
  }
  await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, thread.orgId, "VIEW_SUPPORT_THREAD", req);
  return Response.json({
    thread: {
      id: thread.id,
      subjectType: thread.subjectType,
      subjectLabel: SUBJECT_LABELS[thread.subjectType] || thread.subjectType,
      status: thread.status,
      lastMessageAt: thread.lastMessageAt,
      createdAt: thread.createdAt,
      org: { id: thread.org.id, name: thread.org.name, status: thread.org.status, admin },
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
  const auth = await requireSuper(req);
  if ("error" in auth) return auth.error;
  const { ctx } = auth;
  const { id } = await params;
  if (!id || id.length > 40) return Response.json({ error: "گفتگو یافت نشد" }, { status: 404 });
  const thread = await db.supportThread.findUnique({ where: { id } });
  if (!thread) return Response.json({ error: "گفتگو یافت نشد" }, { status: 404 });
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = strField(body.action, 20);
    if (!action) return Response.json({ error: "نوع عملیات مشخص نیست" }, { status: 400 });

    // ── پاسخ سازنده ──
    if (action === "reply") {
      if (!(await supportWriteAllowed(`vendor:${ctx.user.id}`))) {
        return Response.json(
          { error: "تلاش‌های زیاد — لطفاً کمی بعد دوباره تلاش کنید" },
          { status: 429, headers: { "Retry-After": "60" } }
        );
      }
      const bodyErr = supportBodyError(body.body);
      if (bodyErr) return Response.json({ error: bodyErr }, { status: 400 });
      const text = (body.body as string).trim();
      const clientRef = body.clientRef === undefined || body.clientRef === null ? null : body.clientRef;
      if (clientRef !== null && !isValidClientRef(clientRef)) {
        return Response.json({ error: "شناسه پیام نامعتبر است" }, { status: 400 });
      }
      if (clientRef) {
        const dup = await db.supportMessage.findUnique({
          where: { threadId_clientRef: { threadId: thread.id, clientRef } },
        });
        if (dup) return Response.json({ ok: true, duplicate: true, messageId: dup.id });
      }
      const msg = await db.supportMessage.create({
        data: { threadId: thread.id, senderSide: "VENDOR", senderName: ctx.user.name, body: text, clientRef },
      });
      await db.supportThread.update({
        where: { id: thread.id },
        data: { status: "ANSWERED", unreadForOrg: true, unreadForVendor: false, lastMessageAt: new Date() },
      });
      await logSaAccess(ctx.user.id, ctx.user.name, thread.orgId, "REPLY_SUPPORT", req);
      return Response.json({ ok: true, duplicate: false, messageId: msg.id, createdAt: msg.createdAt });
    }

    // ── تعیین وضعیت گفتگو ──
    if (action === "status") {
      const status = strField(body.status, 20);
      if (!["OPEN", "ANSWERED", "CLOSED"].includes(status)) {
        return Response.json({ error: "وضعیت نامعتبر است" }, { status: 400 });
      }
      if (thread.status === status) {
        return Response.json({ error: "وضعیت گفتگو از قبل همین است" }, { status: 400 });
      }
      await db.supportThread.update({ where: { id: thread.id }, data: { status } });
      await logSaAccess(ctx.user.id, ctx.user.name, thread.orgId, "SET_SUPPORT_STATUS", req, status);
      return Response.json({ ok: true, status });
    }

    return Response.json({ error: "عملیات نامعتبر است" }, { status: 400 });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") {
      return Response.json({ ok: true, duplicate: true });
    }
    console.error("sa support action error", (e as Error)?.name || "unknown");
    return Response.json({ error: "خطا در عملیات پشتیبانی" }, { status: 500 });
  }
}
