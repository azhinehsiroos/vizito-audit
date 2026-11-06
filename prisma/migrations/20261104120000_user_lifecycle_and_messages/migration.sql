-- ============================================================================
-- v1.1.0 — چرخه حیات کاربر/لایسنس + صندوق پیام داخلی
-- ----------------------------------------------------------------------------
-- ۱) User: ستون‌های جدید kind / disabled / trialUntil (افزایشی — ADD COLUMN)
-- ۲) AccessGrant: expiresAt اختیاری شد (null = اعتبار دائمی واقعی بدون سقف)
--    بازسازی جدول با کپی کامل ردیف‌ها — هیچ داده‌ای از بین نمی‌رود
-- ۳) LicenseSale: ستون pauseDeletion (توقف حذف خودکار توسط سازنده)
-- ۴) جداول جدید Message / MessageRecipient (صندوق پیام + وضعیت خوانده‌شدن)
-- همه تغییرات افزایشی/سازگار با SQLite و بدون DROP داده هستند.
-- ============================================================================

-- ── ۱) ستون‌های جدید جدول User ──────────────────────────────────────────────
-- نوع حساب: STAFF = پرسنل تعریف‌شده توسط مدیر (معاف از قفل پایان ترِیال عمومی)
--           PUBLIC = کاربر عمومی ثبت‌نام‌شده (ترِیال شخصی ۲۴ ساعته)
-- کاربران موجود = پرسنل (STAFF) تا رفتار فعلی حفظ شود
ALTER TABLE "User" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'STAFF';
-- غیرفعال‌سازی مستقل حساب بدون حذف اطلاعات — ورود و نشست‌ها در سطح سرور مسدود می‌شود
ALTER TABLE "User" ADD COLUMN "disabled" BOOLEAN NOT NULL DEFAULT false;
-- ترِیال شخصی ۲۴ ساعته کاربر عمومی — فقط یک‌بار هنگام ثبت‌نام نوشته می‌شود
ALTER TABLE "User" ADD COLUMN "trialUntil" DATETIME;

-- ── ۲) AccessGrant.expiresAt → nullable (null = دائمی) ─────────────────────
-- بازسازی جدول طبق الگوی رسمی Prisma برای SQLite — کپی کامل ردیف‌ها
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AccessGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "sections" TEXT NOT NULL DEFAULT '[]',
    "expiresAt" DATETIME,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AccessGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AccessGrant" ("createdAt", "expiresAt", "id", "note", "sections", "updatedAt", "userId")
  SELECT "createdAt", "expiresAt", "id", "note", "sections", "updatedAt", "userId" FROM "AccessGrant";
DROP TABLE "AccessGrant";
ALTER TABLE "new_AccessGrant" RENAME TO "AccessGrant";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- ── ۳) LicenseSale.pauseDeletion ───────────────────────────────────────────
ALTER TABLE "LicenseSale" ADD COLUMN "pauseDeletion" BOOLEAN NOT NULL DEFAULT false;

-- ── ۴) صندوق پیام داخلی ────────────────────────────────────────────────────
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "senderId" TEXT,
    "senderName" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "important" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "MessageRecipient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageRecipient_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MessageRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Message_createdAt_idx" ON "Message"("createdAt");
CREATE UNIQUE INDEX "MessageRecipient_messageId_userId_key" ON "MessageRecipient"("messageId", "userId");
CREATE INDEX "MessageRecipient_userId_readAt_idx" ON "MessageRecipient"("userId", "readAt");
