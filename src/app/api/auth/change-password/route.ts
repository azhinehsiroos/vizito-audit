import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getAuth, unauthorized, forbidden, hashPassword, verifyPassword, passwordError, getTokenFromRequest, csrfGate } from "@/lib/auth";

/**
 * تغییر رمز عبور خود کاربر — هر کاربر واردشده
 * body: { currentPassword, newPassword }
 * برای امنیت، همه نشست‌های دیگر کاربر باطل می‌شود (نشست فعلی حفظ می‌شود)
 */
export async function POST(req: NextRequest) {
  // ── ضد CSRF (ممیزی v1.0.9): این مسیر تغییردهنده بود و از گیت جا مانده بود ──
  const csrf = csrfGate(req);
  if (csrf) return csrf;
  const ctx = await getAuth(req);
  if (!ctx) return unauthorized();
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
    if (!currentPassword || !newPassword) {
      return Response.json({ error: "رمز فعلی و رمز جدید الزامی است" }, { status: 400 });
    }
    const pwdErr = passwordError(newPassword);
    if (pwdErr) {
      return Response.json({ error: pwdErr }, { status: 400 });
    }
    const user = await db.user.findUnique({ where: { id: ctx.user.id } });
    if (!user) return unauthorized();
    if (!(await verifyPassword(currentPassword, user.password))) {
      return forbidden("رمز عبور فعلی درست نیست");
    }
    if (await verifyPassword(newPassword, user.password)) {
      return Response.json({ error: "رمز جدید نباید همان رمز فعلی باشد" }, { status: 400 });
    }
    await db.user.update({ where: { id: user.id }, data: { password: await hashPassword(newPassword) } });
    // باطل کردن همه نشست‌های دیگر — کاربر فعلی داخل می‌ماند
    const currentToken = getTokenFromRequest(req);
    if (currentToken) {
      const crypto = await import("crypto");
      const currentHash = crypto.createHash("sha256").update(currentToken).digest("hex");
      await db.authSession.deleteMany({
        where: { userId: user.id, tokenHash: { not: currentHash } },
      });
    }
    return Response.json({ ok: true });
  } catch (e) {
    console.error("change password error", e);
    return Response.json({ error: "خطا در تغییر رمز عبور" }, { status: 500 });
  }
}
