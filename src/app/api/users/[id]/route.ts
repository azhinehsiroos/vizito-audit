import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden, hashPassword, passwordError } from "@/lib/auth";
import { isOwnerMobile } from "@/lib/license";

type Params = { params: Promise<{ id: string }> };

/**
 * مدیریت حساب کاربر توسط مدیر:
 *  - { password } — تعیین رمز جدید (نشست‌ها ابطال می‌شود)
 *  - { disabled: true|false } — غیرفعال/فعال‌سازی مستقل حساب (غیرفعال‌سازی ⇒ ابطال نشست‌ها)
 *  هر دو می‌توانند همزمان ارسال شوند. حساب سازنده فقط توسط خود سازنده قابل تغییر است.
 */
export async function PUT(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, "users");
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) return forbidden("فقط مدیر می‌تواند حساب کاربران را تغییر دهد");
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const hasPassword = typeof body.password === "string";
    const disableAction = typeof body.disabled === "boolean" ? (body.disabled as boolean) : null;
    if (!hasPassword && disableAction === null) {
      return Response.json({ error: "چیزی برای تغییر ارسال نشده است" }, { status: 400 });
    }
    const target = await db.user.findUnique({ where: { id } });
    if (!target) return Response.json({ error: "کاربر یافت نشد" }, { status: 404 });
    // امنیت: حساب سازنده فقط توسط خود سازنده قابل تغییر است (حذف/رمز/غیرفعال‌سازی)
    if (isOwnerMobile(target.mobile) && !isOwnerMobile(auth.ctx.user.mobile)) {
      return Response.json({ error: "تغییر این حساب مجاز نیست" }, { status: 403 });
    }
    // غیرفعال‌سازی فقط برای حساب‌های پرسنلی/کاربر — حساب مدیر از این مسیر غیرفعال نمی‌شود
    if (disableAction !== null) {
      if (target.role === "ADMIN") {
        return Response.json({ error: "حساب مدیر از این مسیر غیرفعال نمی‌شود" }, { status: 400 });
      }
      if (target.id === auth.ctx.user.id) {
        return Response.json({ error: "حساب خودتان قابل غیرفعال‌سازی نیست" }, { status: 400 });
      }
    }

    const data: { password?: string; disabled?: boolean } = {};
    if (hasPassword) {
      const password = body.password as string;
      const pwdErr = passwordError(password);
      if (pwdErr) return Response.json({ error: pwdErr }, { status: 400 });
      data.password = await hashPassword(password);
    }
    if (disableAction !== null) data.disabled = disableAction;

    await db.user.update({ where: { id }, data });
    // سیاست امنیتی: تغییر رمز یا غیرفعال‌سازی ⇒ ابطال همه نشست‌های فعال کاربر
    if (hasPassword || disableAction === true) {
      await db.authSession.deleteMany({ where: { userId: id } });
    }
    return Response.json({ ok: true, disabled: disableAction === null ? target.disabled : disableAction });
  } catch (e) {
    console.error("admin update user error", e);
    return Response.json({ error: "خطا در تغییر حساب کاربر" }, { status: 500 });
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
