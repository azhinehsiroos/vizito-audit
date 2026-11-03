import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireAuth, forbidden } from "@/lib/auth";
import { isOwnerMobile } from "@/lib/license";

/** ذخیره قیمت بازه‌های لایسنس و آیدی تلگرام پشتیبانی — فقط سازنده برنامه */
export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  if (!auth.ctx.isAdmin || !isOwnerMobile(auth.ctx.user.mobile)) {
    return forbidden("این بخش فقط برای سازنده برنامه فعال است");
  }
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const raw = (body.prices ?? {}) as Record<string, unknown>;
    const clean = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 40) : "");
    const prices = {
      m1: clean(raw.m1),
      m3: clean(raw.m3),
      m6: clean(raw.m6),
      y1: clean(raw.y1),
    };
    const telegram = typeof body.telegram === "string" ? body.telegram.trim().replace(/^@/, "").slice(0, 60) : "";
    const upserts = [
      { key: "license_prices", value: JSON.stringify(prices) },
      ...(telegram ? [{ key: "support_telegram", value: telegram }] : []),
    ];
    for (const u of upserts) {
      await db.setting.upsert({ where: { key: u.key }, update: { value: u.value }, create: u });
    }
    return Response.json({ ok: true, prices, telegram });
  } catch (e) {
    console.error("license settings error", e);
    return Response.json({ error: "خطا در ذخیره تنظیمات" }, { status: 500 });
  }
}
