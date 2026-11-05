import { db } from "@/lib/db";

/**
 * اعلان خودکار تغییرات کاتالوگ (گروه/کالا/قیمت/آفر) به کاربران همان مجموعه به‌جز انجام‌دهنده.
 * چندمجموعه‌ای: اعلان هیچ‌وقت از مرز مجموعه عبور نمی‌کند.
 */
export async function notifyCatalogChange(
  actorId: string,
  orgId: string | null,
  title: string,
  body: string
): Promise<void> {
  try {
    const users = await db.user.findMany({
      where: { id: { not: actorId }, ...(orgId ? { orgId } : {}) },
      select: { id: true },
    });
    if (users.length === 0) return;
    await db.notification.createMany({
      data: users.map((u) => ({ userId: u.id, title, body, type: "CATALOG" as const })),
    });
  } catch (e) {
    // اعلان هرگز نباید مسیر اصلی (ثبت تغییرات) را بشکند
    console.error("notify catalog change error", e);
  }
}
