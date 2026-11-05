#!/usr/bin/env node
"use strict";

/**
 * ---------------------------------------------------------------------------
 * scripts/backfill-multi-tenant.cjs — بک‌فیل چندمجموعه‌ای (M3) — نسخه ۲.۰
 * ---------------------------------------------------------------------------
 * هدف: تبدیل نصب تک‌شرکتی موجود به مدل چندمجموعه‌ای «بدون حذف حتی یک ردیف».
 *
 * کاری که انجام می‌دهد (فقط INSERT/UPDATE افزونه‌ای):
 *  ۱) اگر از قبل مجموعه‌ای وجود داشته باشد ⇒ هیچ کاری نمی‌کند (idempotent)
 *  ۲) ساخت «مجموعه پیش‌فرض» از نصب فعلی (نام از شرکت اولین مدیر)
 *  ۳) نسبت‌دادن orgId به همه ردیف‌های تجاری: کاربران، مشتریان، گروه‌ها، کالاها،
 *     سفارش‌ها و پرداخت‌ها
 *  ۴) نگاشت نقش‌ها:
 *      - موبایل ∈ OWNER_MOBILES (role ADMIN) → SUPER_ADMIN (خارج از مجموعه)
 *      - ADMIN دیگر → ORG_ADMIN
 *      - USER → VISITOR (همه گرنت‌ها و ترِیال شخصی دست‌نخورده)
 *  ۵) لایسنس مجموعه پیش‌فرض مطابق وضعیت واقعی نصب:
 *      - اگر حساب سازنده (OWNER_MOBILES) روی نصب هست ⇒ PERM دائمی
 *        (رفتار فعلی: وجود حساب سازنده کل نصب را باز می‌کند — دقیقاً حفظ می‌شود)
 *      - وگرنه کلید VZT2 ذخیره‌شده معتبر ⇒ لایسنس مدت‌دار با همان انقضای مؤثر
 *      - وگرنه تریال نصب (Setting: trial_until) ⇒ trialEndsAt همان تاریخ (گذشته یا آینده)
 *      - وگرنه هیچ (فاز NOT_ACTIVATED)
 *  ۶) صحت‌سنجی: شمارش همه جدول‌ها قبل/بعد باید «دقیقاً» برابر باشد؛ orgId تهی در
 *     جداول تجاری صفر شود؛ در غیر این صورت خطا و خروج ۱ (هیچ rollback لازم نیست —
 *     اسکریپت فقط ستون‌های جدید را پر می‌کند).
 *
 * اجرا:  node scripts/backfill-multi-tenant.cjs
 * (DATABASE_URL مثل برنامه از env خوانده می‌شود — روی cPanel همان .env)
 * اجرای مکرر بی‌خطر است؛ هر بار فقط صحت‌سنجی می‌کند.
 * ---------------------------------------------------------------------------
 */

const path = require("path");

function log(msg) {
  console.log("[vizito-backfill] " + msg);
}
function warn(msg) {
  console.warn("[vizito-backfill] ⚠ " + msg);
}

async function main() {
  // اطمینان از بارگذاری env (مثل برنامه — .env در ریشه)
  try {
    require("dotenv").config();
  } catch {
    /* dotenv اختیاری است — روی cPanel env از قبل تنظیم است */
  }

  const { PrismaClient } = require("@prisma/client");
  const db = new PrismaClient({ log: ["error", "warn"] });

  try {
    // ── شمارش قبل ──
    const [
      usersBefore, customersBefore, groupsBefore, productsBefore,
      ordersBefore, orderItemsBefore, paymentsBefore, orgsBefore,
    ] = await Promise.all([
      db.user.count(),
      db.customer.count(),
      db.productGroup.count(),
      db.product.count(),
      db.order.count(),
      db.orderItem.count(),
      db.payment.count(),
      db.org.count(),
    ]);

    const ownerMobiles = (process.env.OWNER_MOBILES || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (orgsBefore > 0) {
      log("از قبل مهاجرت انجام شده است (مجموعه‌ها: " + orgsBefore + ") — فقط صحت‌سنجی:");
      await verify(db, {
        usersBefore, customersBefore, groupsBefore, productsBefore,
        ordersBefore, orderItemsBefore, paymentsBefore,
      }, orgsBefore);
      return;
    }

    if (usersBefore === 0) {
      log("نصب خالی است (هیچ کاربری نیست) — بک‌فیل لازم نیست؛ اولین ثبت‌نام خودش مجموعه می‌سازد.");
      return;
    }

    log("شروع بک‌فیل — کاربران: " + usersBefore + " | مشتریان: " + customersBefore + " | سفارش‌ها: " + ordersBefore);

    // ── ۱) مجموعه پیش‌فرض ──
    const firstAdmin = await db.user.findFirst({
      where: { role: { in: ["ADMIN", "ORG_ADMIN"] } },
      orderBy: { createdAt: "asc" },
    });
    const orgName = ((firstAdmin && firstAdmin.company) || "مجموعه پیش‌فرض").slice(0, 80);
    const defaultOrg = await db.org.create({ data: { name: orgName, status: "ACTIVE" } });
    log("مجموعه پیش‌فرض ساخته شد: «" + orgName + "» (" + defaultOrg.id + ")");

    // ── ۲) لایسنس مجموعه پیش‌فرض مطابق وضعیت واقعی نصب ──
    const ownerAccount = ownerMobiles.length
      ? await db.user.findFirst({
          where: { mobile: { in: ownerMobiles }, role: { in: ["ADMIN", "SUPER_ADMIN"] } },
          select: { id: true, mobile: true },
        })
      : null;

    let licenseMode = "NONE";
    if (ownerAccount) {
      await db.license.create({
        data: {
          orgId: defaultOrg.id,
          plan: "PERM",
          status: "ACTIVE",
          source: "MIGRATION",
          expiresAt: null,
          note: "ارتقای نصب موجود — دسترسی سازنده روی این نصب فعال است",
        },
      });
      licenseMode = "PERM (حساب سازنده موجود است)";
    } else {
      const effective = await effectiveStoredExpiry(db);
      if (effective && effective.permanent) {
        await db.license.create({
          data: { orgId: defaultOrg.id, plan: "PERM", status: "ACTIVE", source: "MIGRATION", expiresAt: null, note: "کلید دائمی VZT2 فعال روی نصب" },
        });
        licenseMode = "PERM (کلید دائمی)";
      } else if (effective && effective.expiresAt > new Date()) {
        await db.license.create({
          data: {
            orgId: defaultOrg.id,
            plan: planFor(effective.expiresAt),
            status: "ACTIVE",
            source: "MIGRATION",
            expiresAt: effective.expiresAt,
            note: "مهاجرت از کلید VZT2 فعال نصب",
          },
        });
        licenseMode = "مدت‌دار تا " + effective.expiresAt.toISOString();
      } else {
        const trialRow = await db.setting.findUnique({ where: { key: "trial_until" } });
        if (trialRow) {
          const t = new Date(trialRow.value);
          if (!Number.isNaN(t.getTime())) {
            await db.org.update({
              where: { id: defaultOrg.id },
              data: { trialEndsAt: t, ...(t > new Date() ? { trialStartsAt: new Date(t.getTime() - 24 * 3600 * 1000) } : {}) },
            });
            licenseMode = "ترِیال " + (t > new Date() ? "فعال" : "تمام‌شده") + " تا " + t.toISOString();
          }
        }
      }
    }
    await db.licenseEvent.create({
      data: {
        orgId: defaultOrg.id,
        type: "MIGRATION",
        note: "بک‌فیل نصب موجود به مدل چندمجموعه‌ای — وضعیت لایسنس نصب عیناً منتقل شد",
      },
    }).catch(() => {});
    log("وضعیت لایسنس مجموعه پیش‌فرض: " + licenseMode);

    // ── ۳) نسبت‌دادن orgId به همه ردیف‌ها ──
    // کاربران: همه به مجموعه پیش‌فرض به‌جز حساب‌های سازنده (خارج از مجموعه)
    const userUpdate = await db.user.updateMany({
      where: { orgId: null },
      data: { orgId: defaultOrg.id },
    });
    if (ownerAccount) {
      await db.user.update({ where: { id: ownerAccount.id }, data: { orgId: null } });
    }
    // نقش‌ها — موبایل سازنده → SUPER_ADMIN و خارج از مجموعه؛ ADMIN دیگر → ORG_ADMIN؛ USER → VISITOR
    const superUp = await db.user.updateMany({
      where: ownerMobiles.length ? { mobile: { in: ownerMobiles }, role: "ADMIN" } : { id: "__none__" },
      data: { role: "SUPER_ADMIN", orgId: null },
    });
    const orgAdminUp = await db.user.updateMany({ where: { role: "ADMIN" }, data: { role: "ORG_ADMIN" } });
    const visitorUp = await db.user.updateMany({ where: { role: "USER" }, data: { role: "VISITOR" } });

    const [c1, g1, p1, o1, pay1] = await Promise.all([
      db.customer.updateMany({ where: { orgId: null }, data: { orgId: defaultOrg.id } }),
      db.productGroup.updateMany({ where: { orgId: null }, data: { orgId: defaultOrg.id } }),
      db.product.updateMany({ where: { orgId: null }, data: { orgId: defaultOrg.id } }),
      db.order.updateMany({ where: { orgId: null }, data: { orgId: defaultOrg.id } }),
      db.payment.updateMany({ where: { orgId: null }, data: { orgId: defaultOrg.id } }),
    ]);

    log(
      "کاربران → مجموعه: " + userUpdate.count +
      " | SUPER_ADMIN: " + superUp.count +
      " | ORG_ADMIN: " + orgAdminUp.count +
      " | VISITOR: " + visitorUp.count
    );
    log(
      "مشتریان: " + c1.count + " | گروه‌ها: " + g1.count + " | کالاها: " + p1.count +
      " | سفارش‌ها: " + o1.count + " | پرداخت‌ها: " + pay1.count
    );

    // ── ۴) صحت‌سنجی ──
    await verify(db, {
      usersBefore, customersBefore, groupsBefore, productsBefore,
      ordersBefore, orderItemsBefore, paymentsBefore,
    }, 1);
    log("بک‌فیل کامل شد ✔ — هیچ داده‌ای حذف یا تغییر معنایی نکرد.");
  } finally {
    await db.$disconnect();
  }
}

/** صحت‌سنجی نهایی: شمارش ردیف‌ها باید دقیقاً همان قبل باشد + پوشش orgId کامل */
async function verify(db, before, expectOrgs) {
  const [
    usersAfter, customersAfter, groupsAfter, productsAfter,
    ordersAfter, orderItemsAfter, paymentsAfter, orgsAfter,
  ] = await Promise.all([
    db.user.count(),
    db.customer.count(),
    db.productGroup.count(),
    db.product.count(),
    db.order.count(),
    db.orderItem.count(),
    db.payment.count(),
    db.org.count(),
  ]);

  const checks = [
    ["User", before.usersBefore, usersAfter],
    ["Customer", before.customersBefore, customersAfter],
    ["ProductGroup", before.groupsBefore, groupsAfter],
    ["Product", before.productsBefore, productsAfter],
    ["Order", before.ordersBefore, ordersAfter],
    ["OrderItem", before.orderItemsBefore, orderItemsAfter],
    ["Payment", before.paymentsBefore, paymentsAfter],
  ];
  let ok = true;
  for (const [name, b, a] of checks) {
    if (b !== a) {
      ok = false;
      console.error("[vizito-backfill] ✖ شمارش " + name + " تغییر کرده: " + b + " → " + a);
    }
  }
  if (orgsAfter < expectOrgs) {
    ok = false;
    console.error("[vizito-backfill] ✖ تعداد مجموعه‌ها کمتر از انتظار است: " + orgsAfter);
  }
  // پوشش orgId در جداول تجاری — کاربرانِ غیرِ سازنده نباید بدون مجموعه باشند
  const [nullCustomers, nullGroups, nullProducts, nullOrders, nullPayments] = await Promise.all([
    db.customer.count({ where: { orgId: null } }),
    db.productGroup.count({ where: { orgId: null } }),
    db.product.count({ where: { orgId: null } }),
    db.order.count({ where: { orgId: null } }),
    db.payment.count({ where: { orgId: null } }),
  ]);
  const nulls = [nullCustomers, nullGroups, nullProducts, nullOrders, nullPayments];
  if (nulls.some((n) => n > 0)) {
    ok = false;
    console.error("[vizito-backfill] ✖ ردیف‌های بدون مجموعه: مشتری=" + nullCustomers + " گروه=" + nullGroups + " کالا=" + nullProducts + " سفارش=" + nullOrders + " پرداخت=" + nullPayments);
  }
  if (!ok) {
    throw new Error("صحت‌سنجی بک‌فیل شکست خورد — قبل از راه‌اندازی برنامه بررسی کنید (هیچ داده‌ای حذف نشده است)");
  }
  log("صحت‌سنجی ✔ — شمارش همه جداول تغییری نکرد و پوشش مجموعه کامل است.");
}

/** انقضای مؤثر کلید VZT2 ذخیره‌شده (همان منطق license.ts — مستقل و بدون import TS) */
async function effectiveStoredExpiry(db) {
  try {
    const row = await db.setting.findUnique({ where: { key: "license_v1" } });
    if (!row) return null;
    const parsed = JSON.parse(row.value);
    if (!parsed || !parsed.key) return null;
    const parts = String(parsed.key).trim().split(".");
    if (parts.length !== 3 || parts[0] !== "VZT2") return null;
    const crypto = require("crypto");
    const fs = require("fs");
    const pubPem =
      process.env.LICENSE_PUBLIC_KEY_PEM ||
      `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEALPavtjcuXbtk+NiS0cBW43I+WwDpbqPKGPPUeOLifbA=
-----END PUBLIC KEY-----`;
    const fromB64url = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const okSig = crypto.verify(null, Buffer.from(parts[1]), crypto.createPublicKey(pubPem), fromB64url(parts[2]));
    if (!okSig) return null;
    const payload = JSON.parse(fromB64url(parts[1]).toString("utf8"));
    if (payload.v !== 2 || typeof payload.e !== "number") return null;
    if (payload.e === 0) return { permanent: true, expiresAt: null };
    const sale = await db.licenseSale.findFirst({ where: { key: parsed.key }, select: { expiresAt: true } });
    const signed = payload.e;
    const saleMs = sale && sale.expiresAt ? sale.expiresAt.getTime() : 0;
    return { permanent: false, expiresAt: new Date(Math.max(signed, saleMs)) };
  } catch (e) {
    warn("خواندن کلید ذخیره‌شده ناموفق بود (نادیده گرفته شد): " + (e && e.message));
    return null;
  }
}

/** نزدیک‌ترین پلن از میان ۳۰/۹۰/۱۸۰/۳۶۵ روز با توجه به روزهای باقی‌مانده */
function planFor(expiresAt) {
  const days = Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000);
  if (days <= 30) return "D30";
  if (days <= 90) return "D90";
  if (days <= 180) return "D180";
  return "D365";
}

main().catch((e) => {
  console.error("[vizito-backfill] ✖ " + (e && e.message));
  process.exit(1);
});
