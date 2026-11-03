import { db } from "@/lib/db";

/**
 * اعلان خودکار تغییرات کاتالوگ (گروه/کالا/قیمت/آفر) به همه کاربران به‌جز انجام‌دهنده.
 * تغییرات بلافاصله برای همه اعمال می‌شود (دیتای مشترک) و این اعلان، کاربران را برای
 * بازدید مجدد و اطلاع از جزئیات تغییر مطلع می‌کند.
 */
export async function notifyCatalogChange(actorId: string, title: string, body: string): Promise<void> {
  try {
    const users = await db.user.findMany({ where: { id: { not: actorId } }, select: { id: true } });
    if (users.length === 0) return;
    await db.notification.createMany({
      data: users.map((u) => ({ userId: u.id, title, body, type: "CATALOG" as const })),
    });
  } catch (e) {
    // اعلان هرگز نباید مسیر اصلی (ثبت تغییرات) را بشکند
    console.error("notify catalog change error", e);
  }
}
