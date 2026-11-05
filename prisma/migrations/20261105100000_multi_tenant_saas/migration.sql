-- AlterTable
ALTER TABLE "Backup" ADD COLUMN "orgId" TEXT;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "orgId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "orgId" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "orgId" TEXT;

-- AlterTable
ALTER TABLE "ProductGroup" ADD COLUMN "orgId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "orgId" TEXT;

-- CreateTable
CREATE TABLE "Org" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "logo" TEXT,
    "inviteCode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "suspendedAt" DATETIME,
    "trialStartsAt" DATETIME,
    "trialEndsAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "License" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'D30',
    "startsAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "source" TEXT NOT NULL DEFAULT 'KEY',
    "currentKeyHash" TEXT,
    "note" TEXT,
    "maxUsers" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "License_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LicenseEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "licenseId" TEXT,
    "type" TEXT NOT NULL,
    "plan" TEXT,
    "days" INTEGER,
    "actorName" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LicenseEvent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LicenseEvent_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "License" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SupportThread" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL DEFAULT 'GENERAL',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "unreadForOrg" BOOLEAN NOT NULL DEFAULT false,
    "unreadForVendor" BOOLEAN NOT NULL DEFAULT true,
    "lastMessageAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupportThread_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SupportMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "senderSide" TEXT NOT NULL,
    "senderName" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "clientRef" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SupportMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "SupportThread" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "deviceKey" TEXT NOT NULL,
    "label" TEXT,
    "userId" TEXT,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Device_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdminAccessLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT,
    "orgId" TEXT,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "ip" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT,
    "clientRef" TEXT,
    "deviceId" TEXT,
    "createdOffline" BOOLEAN NOT NULL DEFAULT false,
    "syncedAt" DATETIME,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "customerId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "title" TEXT,
    "priceType" TEXT NOT NULL DEFAULT 'STORE',
    "status" TEXT NOT NULL DEFAULT 'FINAL',
    "totalAmount" REAL NOT NULL DEFAULT 0,
    "settlementType" TEXT,
    "dueDays" INTEGER,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Order" ("createdAt", "createdByUserId", "customerId", "dueDays", "id", "note", "priceType", "settlementType", "status", "title", "totalAmount", "updatedAt") SELECT "createdAt", "createdByUserId", "customerId", "dueDays", "id", "note", "priceType", "settlementType", "status", "title", "totalAmount", "updatedAt" FROM "Order";
DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";
CREATE UNIQUE INDEX "Order_clientRef_key" ON "Order"("clientRef");
CREATE INDEX "Order_orgId_createdAt_idx" ON "Order"("orgId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "License_orgId_key" ON "License"("orgId");

-- CreateIndex
CREATE INDEX "LicenseEvent_orgId_createdAt_idx" ON "LicenseEvent"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportThread_orgId_lastMessageAt_idx" ON "SupportThread"("orgId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "SupportThread_unreadForVendor_lastMessageAt_idx" ON "SupportThread"("unreadForVendor", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportMessage_threadId_clientRef_key" ON "SupportMessage"("threadId", "clientRef");

-- CreateIndex
CREATE UNIQUE INDEX "Device_deviceKey_key" ON "Device"("deviceKey");

-- CreateIndex
CREATE INDEX "AdminAccessLog_orgId_createdAt_idx" ON "AdminAccessLog"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAccessLog_actorId_createdAt_idx" ON "AdminAccessLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "Backup_orgId_createdAt_idx" ON "Backup"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Customer_orgId_archived_idx" ON "Customer"("orgId", "archived");

-- CreateIndex
CREATE INDEX "Payment_orgId_createdAt_idx" ON "Payment"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "Product_orgId_idx" ON "Product"("orgId");

-- CreateIndex
CREATE INDEX "ProductGroup_orgId_idx" ON "ProductGroup"("orgId");

