import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireSuper, logSaAccess, adminAccessLogData } from "@/lib/sa";
import { makeOrgLicenseKey, isLicensePlan, PLAN_DAYS, LicenseControlError } from "@/lib/license";
import { strField, clampNum } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * مدیریت لایسنس مجموعه‌ها — فقط سازنده (SUPER_ADMIN).
 *
 * عملیات (POST — بر اساس action):
 *  - issue    : صدور/تعیین مستقیم لایسنس مجموعه (plan: D30|D90|D180|D365|PERM)
 *  - issueKey : تولید کلید VZT3 برای مجموعه (کلید امضاشده — مشتری خودش فعال می‌کند)
 *  - extend   : تمدید زودهنگام + days روز (از max(انقضای فعلی، امروز))
 *  - suspend  : تعلیق مجموعه (کل APIهای تجاری ۴۰۲؛ رفع آن فقط با resume)
 *  - resume   : فعال‌سازی مجدد مجموعه تعلیق‌شده
 *
 * GET بدون orgId  : فهرست مجموعه‌ها + خلاصه لایسنس (برای پنل سازنده)
 * GET با  orgId   : جزئیات + تاریخچه کامل رویدادهای لایسنس (سوابق صدور/تمدید/تعلیق)
 *
 * امنیت:
 *  - فقط حساب سازنده (نقش SUPER_ADMIN یا موبایل سازنده env)
 *  - هر عملیات/مشاهده در AdminAccessLog ثبت می‌شود (حسابرسی الزام سند — بخش پنجم)
 *  - هیچ داده‌ای از این مسیر حذف نمی‌شود؛ تعلیق/انقضا فقط دسترسی را محدود می‌کند (D2)
 */

// گیت سازنده + حسابرسی — پیاده‌سازی مشترک در src/lib/sa.ts (همان رفتار، یک منبع حقیقت)

function licenseSummary(l: { plan: string; expiresAt: Date | null; status: string } | null) {
  if (!l) return null;
  return { plan: l.plan, expiresAt: l.expiresAt ? l.expiresAt.toISOString() : null, status: l.status };
}

export async function GET(req: NextRequest) {
  const auth = await requireSuper(req);
  if ("error" in auth) return auth.error;
  const orgId = strField(req.nextUrl.searchParams.get("orgId"), 40);
  try {
    if (orgId) {
      const org = await db.org.findUnique({
        where: { id: orgId },
        include: { license: true },
      });
      if (!org) return Response.json({ error: "مجموعه یافت نشد" }, { status: 404 });
      const [events, users, admin] = await Promise.all([
        db.licenseEvent.findMany({ where: { orgId }, orderBy: { createdAt: "desc" }, take: 100 }),
        db.user.findMany({
          where: { orgId },
          select: { id: true, name: true, mobile: true, role: true, disabled: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        }),
        db.user.findFirst({
          where: { orgId, role: { in: ["ORG_ADMIN", "ADMIN"] } },
          select: { name: true, mobile: true, company: true },
        }),
      ]);
      await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, orgId, "VIEW_LICENSE", req);
      return Response.json({
        org: { id: org.id, name: org.name, status: org.status, trialEndsAt: org.trialEndsAt, createdAt: org.createdAt },
        admin,
        users,
        license: licenseSummary(org.license),
        events: events.map((e) => ({
          id: e.id,
          type: e.type,
          plan: e.plan,
          days: e.days,
          actorName: e.actorName,
          note: e.note,
          createdAt: e.createdAt,
        })),
      });
    }
    const orgs = await db.org.findMany({
      include: { license: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    // شمارش کاربران هر مجموعه — بدون رابطه FK (بهینه: یک groupBy)
    const userCounts = await db.user.groupBy({
      by: ["orgId"],
      _count: { _all: true },
      where: { orgId: { in: orgs.map((o) => o.id) } },
    });
    const countMap = new Map<string, number>(
      userCounts.filter((c) => c.orgId).map((c) => [c.orgId as string, c._count._all])
    );
    await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, null, "VIEW_LICENSES", req);
    return Response.json({
      orgs: orgs.map((o) => ({
        id: o.id,
        name: o.name,
        status: o.status,
        trialEndsAt: o.trialEndsAt,
        usersCount: countMap.get(o.id) ?? 0,
        license: licenseSummary(o.license),
        createdAt: o.createdAt,
      })),
    });
  } catch (e) {
    console.error("sa license get error", e);
    return Response.json({ error: "خطا در دریافت وضعیت لایسنس" }, { status: 500 });
  }
}

/** یادداشت اختیاری — حداکثر ۲۰۰ کاراکتر یا null */
function strOrNull400(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, 200) : null;
}

export async function POST(req: NextRequest) {
  const auth = await requireSuper(req);
  if ("error" in auth) return auth.error;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = strField(body.action, 20);
    const orgId = strField(body.orgId, 40);
    const note = strOrNull400(body.note);
    if (!action) return Response.json({ error: "نوع عملیات مشخص نیست" }, { status: 400 });
    if (!orgId) return Response.json({ error: "شناسه مجموعه الزامی است" }, { status: 400 });
    const org = await db.org.findUnique({ where: { id: orgId } });
    if (!org) return Response.json({ error: "مجموعه یافت نشد" }, { status: 404 });

    // ── صدور/تعیین مستقیم لایسنس ──
    // M2 (اصلاح فاز B): mutation + LicenseEvent + AdminAccessLog در «یک تراکنش» —
    // هیچ تغییر وضعیتی بدون ثبت معتبر هر دو گزارشcommit نمی‌شود (fail-closed)
    if (action === "issue") {
      const plan = body.plan;
      if (!isLicensePlan(plan)) {
        return Response.json({ error: "مدت لایسنس نامعتبر است (۳۰/۹۰/۱۸۰/۳۶۵ روز یا دائمی)" }, { status: 400 });
      }
      const permanent = plan === "PERM";
      const expiresAt = permanent ? null : new Date(Date.now() + PLAN_DAYS[plan] * 86_400_000);
      await db.$transaction(async (tx) => {
        const existing = await tx.license.findUnique({ where: { orgId } });
        if (existing) {
          await tx.license.update({
            where: { id: existing.id },
            data: { plan, expiresAt, status: "ACTIVE", source: "ADMIN", note },
          });
        } else {
          await tx.license.create({
            data: { orgId, plan, expiresAt, status: "ACTIVE", source: "ADMIN", note },
          });
        }
        await tx.licenseEvent.create({
          data: { orgId, type: "ISSUE", plan, actorName: auth.ctx.user.name, note: note || (permanent ? "لایسنس دائمی" : `صدور ${PLAN_DAYS[plan]} روزه`) },
        });
        await tx.adminAccessLog.create({
          data: adminAccessLogData(auth.ctx.user.id, auth.ctx.user.name, orgId, "ISSUE_LICENSE", req, plan),
        });
      });
      return Response.json({ ok: true, plan, expiresAt: expiresAt ? expiresAt.toISOString() : null });
    }

    // ── تولید کلید VZT3 ──
    if (action === "issueKey") {
      const plan = body.plan;
      if (!isLicensePlan(plan)) {
        return Response.json({ error: "مدت لایسنس نامعتبر است (۳۰/۹۰/۱۸۰/۳۶۵ روز یا دائمی)" }, { status: 400 });
      }
      const permanent = plan === "PERM";
      const expiresAt = permanent ? null : new Date(Date.now() + PLAN_DAYS[plan] * 86_400_000);
      let key: string;
      try {
        key = makeOrgLicenseKey(orgId, expiresAt, org.name);
      } catch (e) {
        if (e instanceof LicenseControlError) return Response.json({ error: e.message }, { status: 400 });
        throw e;
      }
      await db.$transaction(async (tx) => {
        await tx.licenseEvent.create({
          data: { orgId, type: "ISSUE", plan, actorName: auth.ctx.user.name, note: note || `کلید VZT3 ${plan} تولید شد` },
        });
        await tx.adminAccessLog.create({
          data: adminAccessLogData(auth.ctx.user.id, auth.ctx.user.name, orgId, "ISSUE_LICENSE_KEY", req, plan),
        });
      });
      return Response.json({ ok: true, key, plan, expiresAt: expiresAt ? expiresAt.toISOString() : null });
    }

    // ── تمدید زودهنگام ──
    if (action === "extend") {
      const days = Math.round(clampNum(body.days, 1, 3650, 0));
      if (days <= 0) return Response.json({ error: "تعداد روز تمدید باید بین ۱ تا ۳۶۵۰ باشد" }, { status: 400 });
      const lic = await db.license.findUnique({ where: { orgId } });
      if (!lic) return Response.json({ error: "این مجموعه هنوز لایسنس ندارد — ابتدا لایسنس صادر کنید" }, { status: 400 });
      if (lic.plan === "PERM" || lic.expiresAt === null) {
        return Response.json({ error: "لایسنس دائمی تمدید نمی‌خواهد" }, { status: 400 });
      }
      // تمدید زودهنگام: از max(انقضای فعلی، امروز) — همان منطق شارژ مجدد نسخه قبلی
      const base = Math.max(lic.expiresAt.getTime(), Date.now());
      const expiresAt = new Date(base + days * 86_400_000);
      await db.$transaction(async (tx) => {
        await tx.license.update({ where: { id: lic.id }, data: { expiresAt, status: "ACTIVE" } });
        await tx.licenseEvent.create({
          data: { orgId, licenseId: lic.id, type: "EXTEND", plan: lic.plan, days, actorName: auth.ctx.user.name, note: note || `تمدید ${days} روزه` },
        });
        await tx.adminAccessLog.create({
          data: adminAccessLogData(auth.ctx.user.id, auth.ctx.user.name, orgId, "EXTEND_LICENSE", req, `+${days}d`),
        });
      });
      return Response.json({ ok: true, expiresAt: expiresAt.toISOString() });
    }

    // ── تعلیق مجموعه ──
    if (action === "suspend") {
      if (org.status === "SUSPENDED") {
        return Response.json({ error: "این مجموعه از قبل تعلیق است" }, { status: 400 });
      }
      await db.$transaction(async (tx) => {
        await tx.org.update({ where: { id: orgId }, data: { status: "SUSPENDED", suspendedAt: new Date() } });
        await tx.licenseEvent.create({
          data: { orgId, type: "SUSPEND", actorName: auth.ctx.user.name, note: note || "تعلیق توسط سازنده" },
        });
        await tx.adminAccessLog.create({
          data: adminAccessLogData(auth.ctx.user.id, auth.ctx.user.name, orgId, "SUSPEND_ORG", req, note || undefined),
        });
      });
      return Response.json({ ok: true, status: "SUSPENDED" });
    }

    // ── فعال‌سازی مجدد ──
    if (action === "resume") {
      if (org.status !== "SUSPENDED") {
        return Response.json({ error: "این مجموعه تعلیق نیست" }, { status: 400 });
      }
      await db.$transaction(async (tx) => {
        await tx.org.update({ where: { id: orgId }, data: { status: "ACTIVE", suspendedAt: null } });
        await tx.licenseEvent.create({
          data: { orgId, type: "RESUME", actorName: auth.ctx.user.name, note: note || "رفع تعلیق" },
        });
        await tx.adminAccessLog.create({
          data: adminAccessLogData(auth.ctx.user.id, auth.ctx.user.name, orgId, "RESUME_ORG", req),
        });
      });
      return Response.json({ ok: true, status: "ACTIVE" });
    }

    return Response.json({ error: "عملیات نامعتبر است" }, { status: 400 });
  } catch (e) {
    console.error("sa license post error", e);
    return Response.json({ error: "خطا در عملیات لایسنس" }, { status: 500 });
  }
}
