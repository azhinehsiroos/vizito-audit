import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { hashPassword, requireAuth, forbidden, passwordError } from "@/lib/auth";
import { normalizeMobile, MOBILE_RE, strField, filterSections, clampNum } from "@/lib/validate";
import { isOwnerMobile } from "@/lib/license";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, "users");
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) return forbidden("فقط مدیر به این بخش دسترسی دارد");
  // چندمجموعه‌ای: مدیر فقط کاربران مجموعه خودش؛ سازنده «بدون مجموعه» پیش‌تر در M1 مسدود است
  // (فاز D: سازندهِ دارای «مجموعه من» هم فقط کاربران همان مجموعه را می‌بیند)
  const users = await db.user.findMany({
    where: auth.ctx.org ? { orgId: auth.ctx.org.id } : {},
    include: { grants: { orderBy: { createdAt: "desc" } } },
    orderBy: { createdAt: "asc" },
  });
  return Response.json(
    users.map((u) => ({
      id: u.id,
      mobile: u.mobile,
      name: u.name,
      company: u.company,
      role: u.role,
      kind: u.kind || "STAFF",
      disabled: u.disabled,
      trialUntil: u.trialUntil,
      createdAt: u.createdAt,
      grants: u.grants,
    }))
  );
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, "users");
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) return forbidden("فقط مدیر می‌تواند کاربر تعریف کند");
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const mobile = normalizeMobile(body.mobile);
    const name = strField(body.name, 80);
    const password = typeof body.password === "string" ? body.password : "";
    if (!MOBILE_RE.test(mobile)) {
      return Response.json({ error: "شماره موبایل نامعتبر است" }, { status: 400 });
    }
    if (!name) return Response.json({ error: "نام کاربر الزامی است" }, { status: 400 });
    const pwdErr = passwordError(password);
    if (pwdErr) {
      return Response.json({ error: pwdErr }, { status: 400 });
    }
    const exists = await db.user.findUnique({ where: { mobile } });
    if (exists) return Response.json({ error: "این شماره قبلاً ثبت شده است" }, { status: 409 });

    // امنیت: ساخت کاربر با شماره سازنده فقط توسط خود سازنده — جلوگیری از باز کردن قفل لایسنس توسط مدیران دیگر
    if (isOwnerMobile(mobile) && !isOwnerMobile(auth.ctx.user.mobile)) {
      return Response.json({ error: "ساخت کاربر با این شماره مجاز نیست" }, { status: 403 });
    }

    // نقش‌های مجاز برای تعریف توسط مدیر مجموعه — SUPER_ADMIN هرگز از این مسیر ساخته نمی‌شود
    const VALID_TARGET_ROLES = ["VISITOR", "SALES_MANAGER", "ORG_ADMIN"] as const;
    const requested = typeof body.role === "string" ? body.role.trim().toUpperCase() : "VISITOR";
    const role = (VALID_TARGET_ROLES as readonly string[]).includes(requested) ? requested : "VISITOR";
    const user = await db.user.create({
      data: {
        mobile,
        name,
        company: strField(body.company, 80) || null,
        password: await hashPassword(password),
        role,
        // چندمجموعه‌ای: کاربر جدید همیشه عضو همان مجموعه مدیرِ سازنده است
        orgId: auth.ctx.org ? auth.ctx.org.id : null,
        kind: "STAFF", // کاربر تعریف‌شده توسط مدیر = پرسنل مجموعه
      },
    });

    // اگر در همان لحظه ساخت، بخش‌ها انتخاب شده باشد → ثبت گرنت
    // مدت: durationHours = null ⇒ اعتبار دائمی واقعی (بدون سقف ۵/۱۰ ساله)
    //      durationHours = عدد ⇒ ساعتی (سقف منطقی ۱۰۰ سال برای جلوگیری از سرریز تاریخ)
    const sections = filterSections(body.sections).filter((s) => s !== "users");
    if (role !== "ORG_ADMIN" && sections.length > 0 && body.durationHours !== undefined) {
      let expiresAt: Date | null = null;
      if (body.durationHours === null) {
        expiresAt = null; // دائمی واقعی
      } else {
        const hours = clampNum(body.durationHours, 1, 876_000, 0);
        if (hours > 0) expiresAt = new Date(Date.now() + hours * 3_600_000);
      }
      if (body.durationHours === null || expiresAt) {
        await db.accessGrant.create({
          data: {
            userId: user.id,
            sections: JSON.stringify(sections),
            expiresAt,
            note: "تعریف اولیه توسط مدیر",
          },
        });
      }
    }
    return Response.json({ id: user.id }, { status: 201 });
  } catch (e) {
    console.error("create user error", e);
    return Response.json({ error: "خطا در ساخت کاربر" }, { status: 500 });
  }
}
