-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Customer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "phone" TEXT NOT NULL,
    "address" TEXT,
    "nationalId" TEXT,
    "type" TEXT NOT NULL DEFAULT 'STORE',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" DATETIME,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Customer" ("address", "company", "createdAt", "createdBy", "id", "name", "nationalId", "phone", "type", "updatedAt") SELECT "address", "company", "createdAt", "createdBy", "id", "name", "nationalId", "phone", "type", "updatedAt" FROM "Customer";
DROP TABLE "Customer";
ALTER TABLE "new_Customer" RENAME TO "Customer";
CREATE INDEX "Customer_archived_idx" ON "Customer"("archived");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
