export async function register() {
  // شروع زمان‌بند پشتیبان‌گیری خودکار — فقط در ران‌تایم Node (سرور)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startBackupScheduler } = await import("@/lib/backup-scheduler");
    await startBackupScheduler();
  }
}
