-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
CREATE TABLE "new_Payment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT,
    "type" TEXT NOT NULL,
    "amount" REAL NOT NULL DEFAULT 0,
    "discountPercent" REAL NOT NULL DEFAULT 0,
    "discountAmount" REAL NOT NULL DEFAULT 0,
    "paidAt" DATETIME,
    "trackingNumber" TEXT,
    "bankName" TEXT,
    "checkNumber" TEXT,
    "sayadiNumber" TEXT,
    "settleAt" DATETIME,
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Payment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Payment_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Payment" ("amount", "bankName", "checkNumber", "createdAt", "createdByUserId", "customerId", "discountAmount", "discountPercent", "id", "note", "orderId", "paidAt", "sayadiNumber", "settleAt", "trackingNumber", "type") SELECT "amount", "bankName", "checkNumber", "createdAt", "createdByUserId", "customerId", "discountAmount", "discountPercent", "id", "note", "orderId", "paidAt", "sayadiNumber", "settleAt", "trackingNumber", "type" FROM "Payment";
DROP TABLE "Payment";
ALTER TABLE "new_Payment" RENAME TO "Payment";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

