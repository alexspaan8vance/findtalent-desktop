-- AlterTable
ALTER TABLE "Candidate" ADD COLUMN "consentGivenAt" DATETIME;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "consentGivenAt" DATETIME;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "sentAt" DATETIME,
    "readAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Notification" ("createdAt", "id", "payloadJson", "readAt", "sentAt", "status", "type", "userId") SELECT "createdAt", "id", "payloadJson", "readAt", "sentAt", "status", "type", "userId" FROM "Notification";
DROP TABLE "Notification";
ALTER TABLE "new_Notification" RENAME TO "Notification";
CREATE INDEX "Notification_userId_status_idx" ON "Notification"("userId", "status");
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
