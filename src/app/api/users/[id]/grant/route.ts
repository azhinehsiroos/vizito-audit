import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden } from "@/lib/auth";
import { strField, filterSections, isFiniteDate } from "@/lib/validate";

type Params = { params: Promise<{ id: string }> };

/** ثبت / تمدید دسترسی کاربر — expiresAt = null یعنی اعتبار دائمی واقعی (بدون سقف) */
export async function POST(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, "users");
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) return forbidden("فقط مدیر می‌تواند دسترسی تعیین کند");
  const { id } = await params;
  try {
    const body = (await req.json()) as {
      sections?: string[];
      expiresAt?: string | null; // ISO — یا null برای دائمی
      note?: string;
    };
    const user = await db.user.findUnique({ where: { id } });
    if (!user) return Response.json({ error: "کاربر یافت نشد" }, { status: 404 });
    // چندمجموعه‌ای: فقط کاربران همان مجموعه
    if ((auth.ctx.org ? auth.ctx.org.id : null) !== (user.orgId ?? null)) {
      return Response.json({ error: "کاربر یافت نشد" }, { status: 404 });
    }
    if (user.role === "ADMIN" || user.role === "ORG_ADMIN" || user.role === "SUPER_ADMIN") {
      return Response.json({ error: "کاربر مدیر به دسترسی نیاز ندارد" }, { status: 400 });
    }
    const sections = filterSections(body.sections).filter((s) => s !== "users");
    if (sections.length === 0) {
      return Response.json({ error: "حداقل یک بخش را انتخاب کنید" }, { status: 400 });
    }
    // دائمی: expiresAt صراحتاً null یا رشته "permanent" — سقف ۵ ساله حذف شد
    let expiresAt: Date | null = null;
    if (body.expiresAt !== null && body.expiresAt !== "permanent") {
      if (!isFiniteDate(body.expiresAt)) {
        return Response.json({ error: "مدت دسترسی الزامی است" }, { status: 400 });
      }
      expiresAt = new Date(body.expiresAt as string);
      if (expiresAt.getTime() <= Date.now()) {
        return Response.json({ error: "زمان انقضا باید در آینده باشد" }, { status: 400 });
      }
    }

    // گرنت‌های قبلی فعال را غیرفعال نکنیم؛ جدیدترین گرنت ملاک است
    const grant = await db.accessGrant.create({
      data: {
        userId: id,
        sections: JSON.stringify(sections),
        expiresAt,
        note: strField(body.note, 200) || null,
      },
    });
    return Response.json(grant, { status: 201 });
  } catch (e) {
    console.error("grant error", e);
    return Response.json({ error: "خطا در ثبت دسترسی" }, { status: 500 });
  }
}
