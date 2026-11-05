import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getAuth, forbidden, csrfGate } from "@/lib/auth";
import { dbRateLimit } from "@/lib/rate-limit";
import { isSupportSubject, supportBodyError, isValidClientRef } from "@/lib/support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * همگام‌سازی دسته‌ای پیام‌های پشتیبانی آفلاین — بخش ۶.۱ سند طراحی SaaS
 * -----------------------------------------------------------------------------
 * POST /api/sync/support   بدنه: { messages: [{clientRef, threadId, subjectType, body}] }
 * پاسخ هر آیتم: { clientRef, threadId?, messageId?, result: ACCEPTED | DUPLICATE | REJECTED(reason) }
 *
 * قواعد:
 * - Idempotency با clientRef (یکتا روی thread) — ارسال مجدد ⇒ DUPLICATE؛ هرگز درج دوباره نیست
 * - threadId خالی ⇒ ساخت رشتهٔ جدید (موضوع اختیاری، پیش‌فرض GENERAL)
 * - threadId پر ⇒ رشته باید متعلق به «مجموعهٔ خود کاربر» باشد (۴۰۴-masking بین مجموعه‌ها)
 * - پیام جدید مجموعه ⇒ بازگشایی خودکار گفتگوی بسته + unreadForVendor (همان رفتار مسیر آنلاین)
 * - بدون قفل لایسنس — پشتیبانی همیشه باز است (الزام سند)
 * - لیمیت پایدار DB: ۱۰/دقیقه (همان سطل نوشتن پشتیبانی)
 */

const MAX_BATCH = 20;

export async function POST(req: NextRequest) {
  const csrf = csrfGate(req);
  if (csrf) return csrf;
  const ctx = await getAuth(req);
  if (!ctx) return Response.json({ error: "احراز هویت نشده است" }, { status: 401 });
  if (!ctx.org) return forbidden("پشتیبانی برای حساب‌های بدون مجموعه در دسترس نیست");
  if (!(await dbRateLimit(`support:${ctx.user.id}`, 10, 60_000))) {
    return Response.json(
      { error: "تلاش‌های زیاد — لطفاً کمی بعد دوباره تلاش کنید" },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }
  const orgId = ctx.org.id;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) return Response.json({ error: "دسته پیام خالی است" }, { status: 400 });
  if (messages.length > MAX_BATCH) {
    return Response.json({ error: `حداکثر ${MAX_BATCH} پیام در هر درخواست` }, { status: 400 });
  }

  const results: {
    clientRef: string;
    threadId?: string;
    messageId?: string;
    result: "ACCEPTED" | "DUPLICATE" | "REJECTED";
    reason?: string;
  }[] = [];

  for (const raw of messages) {
    const m = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const clientRef = typeof m.clientRef === "string" ? m.clientRef : "";
    if (!isValidClientRef(clientRef)) {
      results.push({ clientRef: (clientRef as string).slice(0, 64) || "(نامعتبر)", result: "REJECTED", reason: "clientRef" });
      continue;
    }
    const bodyErr = supportBodyError(m.body);
    if (bodyErr) {
      results.push({ clientRef, result: "REJECTED", reason: "body" });
      continue;
    }
    const text = (m.body as string).trim();
    const threadId = typeof m.threadId === "string" ? m.threadId.trim() : "";

    try {
      if (!threadId) {
        // ساخت رشتهٔ جدید — موضوع فقط از لیست مجاز
        const subjectType = m.subjectType === undefined || m.subjectType === null ? "GENERAL" : m.subjectType;
        if (!isSupportSubject(subjectType)) {
          results.push({ clientRef, result: "REJECTED", reason: "subject" });
          continue;
        }
        // ضد تکرار سراسری در مجموعه — حتی با threadId خالی، clientRef تکراری = DUPLICATE
        const dupNew = await db.supportMessage.findFirst({
          where: { clientRef, thread: { orgId } },
          include: { thread: true },
        });
        if (dupNew) {
          results.push({ clientRef, threadId: dupNew.threadId, messageId: dupNew.id, result: "DUPLICATE" });
          continue;
        }
        const thread = await db.supportThread.create({
          data: {
            orgId, // فقط از نشست سمت سرور
            subjectType,
            unreadForVendor: true,
            unreadForOrg: false,
            messages: { create: { senderSide: "ORG", senderName: ctx.user.name, body: text, clientRef } },
          },
          include: { messages: { orderBy: { createdAt: "asc" } } },
        });
        const first = thread.messages[0];
        results.push({ clientRef, threadId: thread.id, messageId: first?.id, result: "ACCEPTED" });
      } else {
        // پیوستن به رشتهٔ موجود — باید داخل مجموعه خود کاربر باشد
        const thread = await db.supportThread.findFirst({ where: { id: threadId, orgId } });
        if (!thread) {
          results.push({ clientRef, result: "REJECTED", reason: "thread" });
          continue;
        }
        const dup = await db.supportMessage.findUnique({
          where: { threadId_clientRef: { threadId: thread.id, clientRef } },
        });
        if (dup) {
          results.push({ clientRef, threadId: thread.id, messageId: dup.id, result: "DUPLICATE" });
          continue;
        }
        const msg = await db.supportMessage.create({
          data: { threadId: thread.id, senderSide: "ORG", senderName: ctx.user.name, body: text, clientRef },
        });
        await db.supportThread.update({
          where: { id: thread.id },
          data: { status: "OPEN", unreadForVendor: true, unreadForOrg: false, lastMessageAt: new Date() },
        });
        results.push({ clientRef, threadId: thread.id, messageId: msg.id, result: "ACCEPTED" });
      }
    } catch (e) {
      // رقابت هم‌زمان روی یکتایی (threadId, clientRef) — DUPLICATE امن
      if ((e as { code?: string })?.code === "P2002") {
        const dup = await db.supportMessage.findFirst({
          where: { clientRef, thread: { orgId } },
        });
        if (dup) {
          results.push({ clientRef, threadId: dup.threadId, messageId: dup.id, result: "DUPLICATE" });
          continue;
        }
      }
      console.error("sync support error", (e as Error)?.name || "unknown");
      results.push({ clientRef, result: "REJECTED", reason: "server" });
    }
  }

  const accepted = results.filter((r) => r.result === "ACCEPTED").length;
  const duplicates = results.filter((r) => r.result === "DUPLICATE").length;
  const rejected = results.filter((r) => r.result === "REJECTED").length;
  return Response.json({ results, accepted, duplicates, rejected });
}
