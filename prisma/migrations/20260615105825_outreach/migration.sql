-- CreateTable
CREATE TABLE "Outreach" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eightvanceTalentId" INTEGER NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "templateKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Outreach_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Outreach_userId_createdAt_idx" ON "Outreach"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Outreach_projectId_idx" ON "Outreach"("projectId");
