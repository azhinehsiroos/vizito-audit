import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { strField, strOrNull } from "@/lib/validate";

/**
 * اعلان‌های کاربر واردشده — آخرین ۵۰ مورد + تعداد خوانده‌نشده
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const [notifications, unreadRow] = await Promise.all([
    db.notification.findMany({
      where: { userId: auth.ctx.user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, title: true, body: true, type: true, readAt: true, createdAt: true },
    }),
    db.notification.count({ where: { userId: auth.ctx.user.id, readAt: null } }),
  ]);
  return Response.json({ notifications, unread: unreadRow });
}

/** علامت‌گذاری به‌عنوان خوانده‌شده — بدون body: همه؛ با ids: فقط همان‌ها */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
  const where: { userId: string; readAt: null; id?: { in: string[] } } = {
    userId: auth.ctx.user.id,
    readAt: null,
  };
  if (Array.isArray(body.ids) && body.ids.length > 0) {
    where.id = { in: body.ids.filter((x): x is string => typeof x === "string").slice(0, 50) };
  }
  const res = await db.notification.updateMany({ where, data: { readAt: new Date() } });
  return Response.json({ ok: true, updated: res.count });
}

/**
 * ارسال یادداشت/پیام مدیر — فقط مدیر
 * { target: "ALL" | userId, title, body? }
 */
export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) {
    return Response.json({ error: "فقط مدیر برنامه می‌تواند یادداشت ارسال کند" }, { status: 403 });
  }
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const title = strField(body.title, 120);
    const text = strOrNull(body.body, 1000);
    const target = typeof body.target === "string" ? body.target : "";
    if (!title) return Response.json({ error: "عنوان پیام الزامی است" }, { status: 400 });
    if (target !== "ALL" && !target) {
      return Response.json({ error: "گیرنده را انتخاب کنید (یک کاربر یا همه)" }, { status: 400 });
    }
    const recipients =
      target === "ALL"
        ? await db.user.findMany({ where: { id: { not: auth.ctx.user.id } }, select: { id: true } })
        : (await db.user.findUnique({ where: { id: target }, select: { id: true } }))
          ? [{ id: target }]
          : [];
    if (recipients.length === 0) {
      return Response.json({ error: "گیرنده‌ای یافت نشد" }, { status: 404 });
    }
    await db.notification.createMany({
      data: recipients.map((r) => ({
        userId: r.id,
        title,
        body: text,
        type: "NOTE" as const,
      })),
    });
    return Response.json({ ok: true, count: recipients.length }, { status: 201 });
  } catch (e) {
    console.error("send notification error", e);
    return Response.json({ error: "خطا در ارسال پیام" }, { status: 500 });
  }
}
