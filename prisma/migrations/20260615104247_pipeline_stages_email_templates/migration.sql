-- CreateTable
CREATE TABLE "PipelineStage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "color" TEXT NOT NULL DEFAULT '#1f6f5c',
    "isTerminal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PipelineStage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EmailTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EmailTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ShortlistEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'NEW',
    "stageId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ShortlistEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ShortlistEntry_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ShortlistEntry_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "PipelineStage" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ShortlistEntry" ("favorite", "id", "matchId", "note", "stage", "updatedAt", "userId") SELECT "favorite", "id", "matchId", "note", "stage", "updatedAt", "userId" FROM "ShortlistEntry";
DROP TABLE "ShortlistEntry";
ALTER TABLE "new_ShortlistEntry" RENAME TO "ShortlistEntry";
CREATE INDEX "ShortlistEntry_userId_idx" ON "ShortlistEntry"("userId");
CREATE INDEX "ShortlistEntry_matchId_idx" ON "ShortlistEntry"("matchId");
CREATE INDEX "ShortlistEntry_stageId_idx" ON "ShortlistEntry"("stageId");
CREATE UNIQUE INDEX "ShortlistEntry_userId_matchId_key" ON "ShortlistEntry"("userId", "matchId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "PipelineStage_organizationId_position_idx" ON "PipelineStage"("organizationId", "position");

-- CreateIndex
CREATE INDEX "EmailTemplate_organizationId_idx" ON "EmailTemplate"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailTemplate_organizationId_key_key" ON "EmailTemplate"("organizationId", "key");
