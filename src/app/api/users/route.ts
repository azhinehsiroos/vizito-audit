import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { hashPassword, requireAuth, forbidden, passwordError } from "@/lib/auth";
import { normalizeMobile, MOBILE_RE, strField, filterSections, clampNum } from "@/lib/validate";
import { isOwnerMobile } from "@/lib/license";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, "users");
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) return forbidden("فقط مدیر به این بخش دسترسی دارد");
  const users = await db.user.findMany({
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

    const role = body.role === "ADMIN" ? "ADMIN" : "USER";
    const user = await db.user.create({
      data: {
        mobile,
        name,
        company: strField(body.company, 80) || null,
        password: await hashPassword(password),
        role,
      },
    });

    // اگر در همان لحظه ساخت، مدت و دسترسی تعیین شده باشد → ثبت گرنت زمان‌دار
    const sections = filterSections(body.sections).filter((s) => s !== "users");
    if (role === "USER" && sections.length > 0) {
      const hours = clampNum(body.durationHours, 0, 87_600, 0); // حداکثر ۱۰ سال
      let expiresAt: Date | null = null;
      if (hours === 0 && body.durationHours === null) {
        expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 3650); // بدون انقضا
      } else if (hours > 0) {
        expiresAt = new Date(Date.now() + hours * 3600000);
      }
      if (expiresAt) {
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
