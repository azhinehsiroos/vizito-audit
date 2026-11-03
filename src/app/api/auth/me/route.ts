import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getAuth, unauthorized, csrfGate } from "@/lib/auth";
import { isOwnerMobile } from "@/lib/license";
import { strField } from "@/lib/validate";

export async function GET(req: NextRequest) {
  const ctx = await getAuth(req);
  if (!ctx) return unauthorized();
  // سازنده برنامه — فقط برای نمایش بخش «فروش لایسنس» در منو
  return Response.json({ ...ctx, isOwner: ctx.isAdmin && isOwnerMobile(ctx.user.mobile) });
}

/** ویرایش پروفایل خود کاربر (نام / نام شرکت) — هر کاربر فقط پروفایل خودش */
export async function PUT(req: NextRequest) {
  // ── ضد CSRF (ممیزی v1.0.9): این مسیر تغییردهنده بود و از گیت جا مانده بود ──
  const csrf = csrfGate(req);
  if (csrf) return csrf;
  const ctx = await getAuth(req);
  if (!ctx) return unauthorized();
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = strField(body.name, 80);
    const company = strField(body.company, 80);
    if (!name) {
      return Response.json({ error: "نام الزامی است" }, { status: 400 });
    }
    const user = await db.user.update({
      where: { id: ctx.user.id },
      data: { name, company: company || null },
      select: { id: true, mobile: true, name: true, company: true, role: true },
    });
    return Response.json({ user });
  } catch (e) {
    console.error("update me error", e);
    return Response.json({ error: "خطا در ذخیره پروفایل" }, { status: 500 });
  }
}
