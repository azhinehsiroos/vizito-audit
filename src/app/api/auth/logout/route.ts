import { NextRequest } from "next/server";
import { revokeToken, getTokenFromRequest, unauthorized, sessionCookie, jsonContentTypeGate } from "@/lib/auth";

/** خروج از حساب — ابطال سمت سرور نشست فعلی + پاک‌سازی کوکی HttpOnly */
export async function POST(req: NextRequest) {
  const csrf = jsonContentTypeGate(req);
  if (csrf) return csrf;
  const token = getTokenFromRequest(req);
  if (!token) return unauthorized();
  await revokeToken(token);
  return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(req, null) } });
}
