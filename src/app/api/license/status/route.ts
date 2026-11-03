import { NextRequest } from "next/server";
import { getAuth } from "@/lib/auth";
import { getLicenseState } from "@/lib/license";
import { db } from "@/lib/db";

/**
 * وضعیت لایسنس:
 * - عمومی (بدون احراز هویت): فقط وضعیت قفل/روزهای باقی‌مانده/شناسه نصب — بدون نام و موبایل دارنده لایسنس
 *   (شناسه نصب لازم است تا خریدار بتواند در تماس با فروشنده بفرستد و کلید مخصوص نصبش صادر شود)
 * - برای کاربر واردشده: وضعیت کامل (نام دارنده و ...)
 * - freshInstall: نصب تازه (هیچ حسابی نیست) — بک‌اند ثبت‌نام اولین مدیر را بدون لایسنس مجاز می‌داند
 *   (با SETUP_TOKEN) و تریال ۲۴ ساعته می‌دهد؛ فرانت‌اند باید به‌جای قفل لایسنس، صفحه ثبت‌نام را نشان دهد.
 *   این پرچم همان اطلاعاتی است که از تلاش برای ثبت‌نام (کد خطای SETUP_TOKEN_REQUIRED) قابل کشف است.
 */
export async function GET(req: NextRequest) {
  try {
    const state = await getLicenseState();
    const freshInstall = (await db.user.count()) === 0;
    const auth = await getAuth(req);
    if (auth) {
      return Response.json({ ...state, freshInstall });
    }
    // نسخه عمومی حداقلی
    return Response.json({
      activated: state.activated,
      valid: state.valid,
      expiresAt: state.expiresAt,
      daysLeft: state.daysLeft,
      trial: state.trial ?? false,
      installId: state.installId ?? null,
      name: null,
      mobile: null,
      ownerUnlocked: false,
      freshInstall,
    });
  } catch (e) {
    console.error("license status error", e);
    return Response.json(
      { activated: false, valid: false, name: null, mobile: null, expiresAt: null, daysLeft: null },
      { status: 200 }
    );
  }
}
