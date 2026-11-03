import { NextRequest } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";
import { requireAuth, forbidden } from "@/lib/auth";

const INVITE_KEY = "invite_code";

function newCode(): string {
  // کد ۸ رقمی خوانا (بدون 0/O و 1/I برای جلوگیری از اشتباه خواندن)
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

/** مشاهده کد دعوت فعلی — فقط مدیر (در صورت نبودن، خودکار ساخته می‌شود) */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, "users");
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) return forbidden("فقط مدیر به کد دعوت دسترسی دارد");
  const row = await db.setting.findUnique({ where: { key: INVITE_KEY } });
  if (row) return Response.json({ inviteCode: row.value });
  const code = newCode();
  await db.setting.create({ data: { key: INVITE_KEY, value: code } });
  return Response.json({ inviteCode: code });
}

/** تولید کد دعوت جدید (کد قبلی باطل می‌شود) — فقط مدیر */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, "users");
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin) return forbidden("فقط مدیر می‌تواند کد دعوت بسازد");
  const code = newCode();
  await db.setting.upsert({
    where: { key: INVITE_KEY },
    update: { value: code },
    create: { key: INVITE_KEY, value: code },
  });
  return Response.json({ inviteCode: code });
}
