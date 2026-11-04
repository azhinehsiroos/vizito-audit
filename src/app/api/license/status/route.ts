import { NextRequest } from "next/server";
import { getAuth } from "@/lib/auth";
import { getLicenseState, licenseLockDetail } from "@/lib/license";
import { db } from "@/lib/db";
import { lifecycleState, runDataRetentionSweep } from "@/lib/lifecycle";

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
    // تریگر تنبل چرخه حیات — صفحه قفل این مسیر را مرتب صدا می‌زند؛ اگر مهلت ۳۰ روزه
    // تمام شده باشد حذف کنترل‌شده (با گارد درون‌پردازشی و شرط فاز) در پس‌زمینه اجرا می‌شود
    if (state.activated && !state.valid && !state.ownerUnlocked) {
      void lifecycleState()
        .then((l) => (l.phase === "SWEEP_DUE" ? runDataRetentionSweep("status-probe") : null))
        .catch(() => {});
    }
    const auth = await getAuth(req);
    // ممیزی v1.1.4 — فاز قفل (TRIAL_OVER/LICENSE_EXPIRED/NOT_ACTIVATED) برای نمایش پیام
    // درست «پایان مهلت رایگان» در صفحه لایسنس (بدون داده حساس)
    const phase = (await licenseLockDetail()).phase;
    if (auth) {
      return Response.json({ ...state, phase, freshInstall });
    }
    // نسخه عمومی حداقلی — شامل وضعیت مهلت تمدید ۳۰ روزه و لایسنس دائمی (بدون داده حساس)
    return Response.json({
      activated: state.activated,
      valid: state.valid,
      expiresAt: state.expiresAt,
      daysLeft: state.daysLeft,
      trial: state.trial ?? false,
      permanent: state.permanent ?? false,
      expiredAt: state.expiredAt ?? null,
      graceUntil: state.graceUntil ?? null,
      graceDaysLeft: state.graceDaysLeft ?? null,
      phase,
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
