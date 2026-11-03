import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden } from "@/lib/auth";
import { strField, filterSections, isFiniteDate } from "@/lib/validate";

type Params = { params: Promise<{ id: string }> };

/** ثبت / تمدید دسترسی زمان‌دار کاربر */
export async function POST(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, "users");
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) return forbidden("فقط مدیر می‌تواند دسترسی تعیین کند");
  const { id } = await params;
  try {
    const body = (await req.json()) as {
      sections?: string[];
      expiresAt?: string; // ISO
      note?: string;
    };
    const user = await db.user.findUnique({ where: { id } });
    if (!user) return Response.json({ error: "کاربر یافت نشد" }, { status: 404 });
    if (user.role === "ADMIN") {
      return Response.json({ error: "کاربر مدیر به دسترسی نیاز ندارد" }, { status: 400 });
    }
    const sections = filterSections(body.sections).filter((s) => s !== "users");
    if (sections.length === 0) {
      return Response.json({ error: "حداقل یک بخش را انتخاب کنید" }, { status: 400 });
    }
    if (!isFiniteDate(body.expiresAt)) {
      return Response.json({ error: "مدت دسترسی الزامی است" }, { status: 400 });
    }
    const expiresAt = new Date(body.expiresAt as string);
    if (expiresAt.getTime() <= Date.now()) {
      return Response.json({ error: "زمان انقضا باید در آینده باشد" }, { status: 400 });
    }
    // حداکثر ۵ سال اعتبار هر گرنت
    const maxExpiry = Date.now() + 1000 * 60 * 60 * 24 * 365 * 5;
    const safeExpiresAt = expiresAt.getTime() > maxExpiry ? new Date(maxExpiry) : expiresAt;

    // گرنت‌های قبلی فعال را غیرفعال نکنیم؛ جدیدترین گرنت ملاک است
    const grant = await db.accessGrant.create({
      data: {
        userId: id,
        sections: JSON.stringify(sections),
        expiresAt: safeExpiresAt,
        note: strField(body.note, 200) || null,
      },
    });
    return Response.json(grant, { status: 201 });
  } catch (e) {
    console.error("grant error", e);
    return Response.json({ error: "خطا در ثبت دسترسی" }, { status: 500 });
  }
}
