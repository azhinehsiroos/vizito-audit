import { NextRequest } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";
import { requireSuper, logSaAccess } from "@/lib/sa";

const INVITE_KEY = "invite_code";

function newCode(): string {
  // کد ۸ رقمی خوانا (بدون 0/O و 1/I برای جلوگیری از اشتباه خواندن)
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

/**
 * M8 (اصلاح فاز B): کد دعوت یک منبع سراسریِ vendor است (گیت ثبت‌نام آزاد روی نصب) —
 * مدیریت آن فقط از آنِ سازنده برنامه است؛ مدیر مجموعه دیگر آن را نمی‌بیند/نمی‌چرخاند
 * تا منبع مشترک چندمستأجری توسط یک مستأجر تغییر نکند.
 */

/** مشاهده کد دعوت فعلی — فقط سازنده (در صورت نبودن، خودکار ساخته می‌شود) */
export async function GET(req: NextRequest) {
  const auth = await requireSuper(req);
  if ("error" in auth) return auth.error;
  try {
    const row = await db.setting.findUnique({ where: { key: INVITE_KEY } });
    if (row) {
      await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, null, "VIEW_INVITE_CODE", req);
      return Response.json({ inviteCode: row.value });
    }
    const code = newCode();
    await db.setting.create({ data: { key: INVITE_KEY, value: code } });
    await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, null, "VIEW_INVITE_CODE", req);
    return Response.json({ inviteCode: code });
  } catch (e) {
    console.error("invite get error", e);
    return Response.json({ error: "خطا در دریافت کد دعوت" }, { status: 500 });
  }
}

/** تولید کد دعوت جدید (کد قبلی باطل می‌شود) — فقط سازنده */
export async function POST(req: NextRequest) {
  const auth = await requireSuper(req);
  if ("error" in auth) return auth.error;
  try {
    const code = newCode();
    await db.setting.upsert({
      where: { key: INVITE_KEY },
      update: { value: code },
      create: { key: INVITE_KEY, value: code },
    });
    await logSaAccess(auth.ctx.user.id, auth.ctx.user.name, null, "ROTATE_INVITE_CODE", req);
    return Response.json({ inviteCode: code });
  } catch (e) {
    console.error("invite rotate error", e);
    return Response.json({ error: "خطا در تولید کد دعوت" }, { status: 500 });
  }
}
