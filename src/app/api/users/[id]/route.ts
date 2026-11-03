import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden, hashPassword, passwordError } from "@/lib/auth";
import { isOwnerMobile } from "@/lib/license";

type Params = { params: Promise<{ id: string }> };

/**
 * تغییر رمز عبور کاربر توسط مدیر — مدیر رمز جدید را تعیین می‌کند
 * body: { password }
 * همه نشست‌های فعال کاربر باطل می‌شود تا با رمز جدید وارد شود
 */
export async function PUT(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, "users");
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) return forbidden("فقط مدیر می‌تواند رمز کاربران را تغییر دهد");
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const password = typeof body.password === "string" ? body.password : "";
    const pwdErr = passwordError(password);
    if (pwdErr) {
      return Response.json({ error: pwdErr }, { status: 400 });
    }
    const target = await db.user.findUnique({ where: { id } });
    if (!target) return Response.json({ error: "کاربر یافت نشد" }, { status: 404 });
    // امنیت: حساب سازنده فقط توسط خود سازنده قابل تغییر است
    if (isOwnerMobile(target.mobile) && !isOwnerMobile(auth.ctx.user.mobile)) {
      return Response.json({ error: "تغییر این حساب مجاز نیست" }, { status: 403 });
    }
    await db.user.update({ where: { id }, data: { password: await hashPassword(password) } });
    // باطل کردن نشست‌های فعال کاربر — باید با رمز جدید وارد شود
    await db.authSession.deleteMany({ where: { userId: id } });
    return Response.json({ ok: true });
  } catch (e) {
    console.error("admin change password error", e);
    return Response.json({ error: "خطا در تغییر رمز کاربر" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, "users");
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) return forbidden("فقط مدیر می‌تواند کاربر حذف کند");
  const { id } = await params;
  if (id === auth.ctx.user.id) {
    return Response.json({ error: "حساب خودتان قابل حذف نیست" }, { status: 400 });
  }
  try {
    const target = await db.user.findUnique({ where: { id } });
    if (!target) return Response.json({ error: "کاربر یافت نشد" }, { status: 404 });
    // امنیت: حساب سازنده حذف نمی‌شود (مگر توسط خود سازنده)
    if (isOwnerMobile(target.mobile) && !isOwnerMobile(auth.ctx.user.mobile)) {
      return Response.json({ error: "حذف این حساب مجاز نیست" }, { status: 403 });
    }
    // جلوگیری از حذف آخرین مدیر سیستم
    if (target.role === "ADMIN") {
      const adminCount = await db.user.count({ where: { role: "ADMIN" } });
      if (adminCount <= 1) {
        return Response.json({ error: "آخرین مدیر سیستم قابل حذف نیست" }, { status: 400 });
      }
    }
    // نشست‌های فعال کاربر هم با حذف کاربر (cascade) باطل می‌شوند
    await db.user.delete({ where: { id } });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "خطا در حذف کاربر" }, { status: 500 });
  }
}
