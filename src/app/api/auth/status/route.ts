import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * وضعیت راه‌اندازی برنامه — عمومی و بدون داده حساس:
 * فقط مشخص می‌کند آیا هیچ حسابی وجود ندارد (حالت راه‌اندازی اولیه).
 */
export async function GET() {
  try {
    const userCount = await db.user.count();
    return Response.json({ needsSetup: userCount === 0 });
  } catch {
    return Response.json({ needsSetup: false });
  }
}
