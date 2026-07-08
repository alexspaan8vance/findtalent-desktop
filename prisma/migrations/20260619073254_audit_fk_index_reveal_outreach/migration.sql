-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Outreach" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eightvanceTalentId" INTEGER NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "templateKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Outreach_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Outreach_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Outreach" ("channel", "createdAt", "eightvanceTalentId", "id", "projectId", "status", "templateKey", "tenantId", "userId") SELECT "channel", "createdAt", "eightvanceTalentId", "id", "projectId", "status", "templateKey", "tenantId", "userId" FROM "Outreach";
DROP TABLE "Outreach";
ALTER TABLE "new_Outreach" RENAME TO "Outreach";
CREATE INDEX "Outreach_userId_createdAt_idx" ON "Outreach"("userId", "createdAt");
CREATE INDEX "Outreach_projectId_idx" ON "Outreach"("projectId");
CREATE INDEX "Outreach_tenantId_idx" ON "Outreach"("tenantId");
CREATE TABLE "new_RevealLock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "eightvanceTalentId" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "revealId" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RevealLock_revealId_fkey" FOREIGN KEY ("revealId") REFERENCES "Reveal" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_RevealLock" ("eightvanceTalentId", "expiresAt", "id", "revealId", "tenantId", "updatedAt", "userId") SELECT "eightvanceTalentId", "expiresAt", "id", "revealId", "tenantId", "updatedAt", "userId" FROM "RevealLock";
DROP TABLE "RevealLock";
ALTER TABLE "new_RevealLock" RENAME TO "RevealLock";
CREATE INDEX "RevealLock_expiresAt_idx" ON "RevealLock"("expiresAt");
CREATE INDEX "RevealLock_revealId_idx" ON "RevealLock"("revealId");
CREATE UNIQUE INDEX "RevealLock_tenantId_eightvanceTalentId_key" ON "RevealLock"("tenantId", "eightvanceTalentId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
