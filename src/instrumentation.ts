export async function register() {
  // شروع زمان‌بندهای پس‌زمینه — فقط در ران‌تایم Node (سرور)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startBackupScheduler } = await import("@/lib/backup-scheduler");
    await startBackupScheduler();
    // چرخه حیات داده — بررسی دوره‌ای پایان مهلت تمدید ۳۰ روزه لایسنس (حذف کنترل‌شده)
    const { startLifecycleScheduler } = await import("@/lib/lifecycle");
    startLifecycleScheduler();
  }
}
