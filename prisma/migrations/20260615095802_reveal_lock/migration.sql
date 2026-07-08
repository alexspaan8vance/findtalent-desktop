-- CreateTable
CREATE TABLE "RevealLock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "eightvanceTalentId" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "revealId" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "RevealLock_expiresAt_idx" ON "RevealLock"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RevealLock_tenantId_eightvanceTalentId_key" ON "RevealLock"("tenantId", "eightvanceTalentId");
