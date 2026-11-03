/**
 * حلقه زمان‌بند پشتیبان‌گیری خودکار — از instrumentation.ts هنگام بالا آمدن سرور اجرا می‌شود.
 */

export async function startBackupScheduler(): Promise<void> {
  try {
    const { startBackupScheduler: start } = await import("@/lib/backup");
    start();
  } catch (e) {
    console.error("backup scheduler init error", e);
  }
}
