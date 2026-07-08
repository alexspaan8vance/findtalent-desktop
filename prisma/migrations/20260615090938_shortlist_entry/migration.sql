-- CreateTable
CREATE TABLE "ShortlistEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'NEW',
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ShortlistEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ShortlistEntry_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ShortlistEntry_userId_idx" ON "ShortlistEntry"("userId");

-- CreateIndex
CREATE INDEX "ShortlistEntry_matchId_idx" ON "ShortlistEntry"("matchId");

-- CreateIndex
CREATE UNIQUE INDEX "ShortlistEntry_userId_matchId_key" ON "ShortlistEntry"("userId", "matchId");
