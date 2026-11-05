import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSuper, logSaAccess } from "@/lib/sa";
import { strField } from "@/lib/validate";
import { SUBJECT_LABELS } from "@/lib/support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * صندوق پشتیبانی سازنده — بخش چهارم سند طراحی (پشتیبانی داخلی)
 * -----------------------------------------------------------------------------
 * GET : فهرست همه رشته‌های پشتیبانی همه مجموعه‌ها + جست‌وجو (نام مجموعه/مدیر/موبایل)
 *       + فیلتر وضعیت/موضوع/فقط-نخوانده + صفحه‌بندی + جمع‌بندی
 *
 * هر مشاهده در AdminAccessLog ثبت می‌شود (VIEW_SUPPORT_INBOX) — الزام حسابرسی سند.
 * هیچ مسیری از این‌جا داده‌ای حذف نمی‌کند؛ فقط مشاهده/پاسخ/وضعیت.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuper(req);
  if ("error" in auth) return auth.error;
  try {
    const sp = req.nextUrl.searchParams;
    const q = strField(sp.get("q"), 60);
    const status = strField(sp.get("status"), 20);
    const subject = strField(sp.get("subject"), 20);
    const unreadOnly = sp.get("unread") === "1";
    const page = Math.max(1, Math.min(500, Number(sp.get("page") || "1") || 1));
    const pageSize = 20;

    const where: Record<string, unknown> = {};
    if (["OPEN", "ANSWERED", "CLOSED"].includes(status)) where.status = status;
    if (["GENERAL", "BUY_LICENSE", "RENEW"].includes(subject)) where.subjectType = subject;
    if (unreadOnly) where.unreadForVendor = true;
    if (q.trim()) {
      // نکته: User.orgId ستون ساده است (بدون FK/رابطه) — کاربران مطابق اول پیدا و
      // سپس رشته‌های مجموعه‌هایشان با orgId فیلتر می‌شود
      const matchingUsers = await db.user.findMany({
        where: {
          OR: [{ name: { contains: q.trim() } }, { mobile: { contains: q.trim() } }],
        },
        select: { orgId: true },
        take: 500,
      });
      const matchedOrgIds = [...new Set(matchingUsers.map((u) => u.orgId).filter((x): x is string => !!x))];
      where.OR = [{ org: { name: { contains: q.trim() } } }, { orgId: { in: matchedOrgIds } }];
    }

    const [total, threads, statusCounts, unreadCount] = await Promise.all([
      db.supportThread.count({ where }),
      db.supportThread.findMany({
        where,
        orderBy: { lastMessageAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          org: { select: { id: true, name: true, status: true } },
          messages: { orderBy: { createdAt: "desc" }, take: 1 },
          _count: { select: { messages: true } },
        },
      }),
      db.supportThread.groupBy({ by: ["status"], _count: { _all: true } }),
      db.supportThread.count({ where: { unreadForVendor: true } }),
    ]);

    // مدیر هر مجموعه (نام/موبایل) — یک کوئری برای همه ردیف‌های همین صفحه
    const orgIds = [...new Set(threads.map((t) => t.org.id))];
    const admins = await db.user.findMany({
      where: { orgId: { in: orgIds }, role: { in: ["ORG_ADMIN", "ADMIN"] } },
      select: { orgId: true, name: true, mobile: true },
    });
    const adminMap = new Map<string, { name: string; mobile: string }>();
    for (const a of admins) if (a.orgId && !adminMap.has(a.orgId)) adminMap.set(a.orgId, { name: a.name, mobile: a.mobile });

    const counts: Record<string, number> = { OPEN: 0, ANSWERED: 0, CLOSED: 0 };
    for (const g of statusCounts) counts[g.status] = g._count._all;

    await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, null, "VIEW_SUPPORT_INBOX", req, `total=${total}`);

    return Response.json({
      threads: threads.map((t) => ({
        id: t.id,
        subjectType: t.subjectType,
        subjectLabel: SUBJECT_LABELS[t.subjectType] || t.subjectType,
        status: t.status,
        unreadForVendor: t.unreadForVendor,
        messagesCount: t._count.messages,
        lastMessageAt: t.lastMessageAt,
        createdAt: t.createdAt,
        org: { id: t.org.id, name: t.org.name, status: t.org.status, admin: adminMap.get(t.org.id) || null },
        lastMessage: t.messages[0]
          ? { body: t.messages[0].body, senderSide: t.messages[0].senderSide, createdAt: t.messages[0].createdAt }
          : null,
      })),
      total,
      page,
      pageSize,
      summary: {
        total: counts.OPEN + counts.ANSWERED + counts.CLOSED,
        open: counts.OPEN,
        answered: counts.ANSWERED,
        closed: counts.CLOSED,
        unread: unreadCount,
      },
    });
  } catch (e) {
    console.error("sa support inbox error", (e as Error)?.name || "unknown");
    return Response.json({ error: "خطا در دریافت صندوق پشتیبانی" }, { status: 500 });
  }
}
