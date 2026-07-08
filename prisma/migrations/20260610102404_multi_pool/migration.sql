/*
  Warnings:

  - You are about to drop the column `eightvanceJobId` on the `Project` table. All the data in the column will be lost.
  - You are about to drop the column `eightvanceTaskId` on the `Project` table. All the data in the column will be lost.
  - You are about to drop the column `tenantId` on the `Project` table. All the data in the column will be lost.
  - You are about to drop the column `tenantId` on the `User` table. All the data in the column will be lost.
  - Added the required column `tenantId` to the `Match` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tenantId` to the `Reveal` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "ProjectPool" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eightvanceJobId" INTEGER,
    "eightvanceTaskId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "lastMatchedAt" DATETIME,
    CONSTRAINT "ProjectPool_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectPool_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Match" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eightvanceTalentId" INTEGER NOT NULL,
    "opaqueId" TEXT NOT NULL,
    "score" REAL NOT NULL,
    "anonymizedPayloadJson" JSONB NOT NULL,
    "skillGapJson" JSONB,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "Match_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Match_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Match" ("anonymizedPayloadJson", "eightvanceTalentId", "expiresAt", "fetchedAt", "id", "opaqueId", "projectId", "score", "skillGapJson") SELECT "anonymizedPayloadJson", "eightvanceTalentId", "expiresAt", "fetchedAt", "id", "opaqueId", "projectId", "score", "skillGapJson" FROM "Match";
DROP TABLE "Match";
ALTER TABLE "new_Match" RENAME TO "Match";
CREATE INDEX "Match_projectId_score_idx" ON "Match"("projectId", "score");
CREATE INDEX "Match_tenantId_idx" ON "Match"("tenantId");
CREATE UNIQUE INDEX "Match_projectId_tenantId_eightvanceTalentId_key" ON "Match"("projectId", "tenantId", "eightvanceTalentId");
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "functionNameId" INTEGER,
    "functionNameLabel" TEXT,
    "functionLevel" INTEGER,
    "locationCity" TEXT NOT NULL,
    "locationCountry" TEXT NOT NULL,
    "locationProvince" TEXT,
    "locationLat" TEXT,
    "locationLng" TEXT,
    "skillsJson" JSONB NOT NULL,
    "languagesJson" JSONB NOT NULL,
    "educationLevel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMatchedAt" DATETIME,
    CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Project" ("createdAt", "educationLevel", "functionLevel", "functionNameId", "functionNameLabel", "id", "languagesJson", "lastMatchedAt", "locationCity", "locationCountry", "locationLat", "locationLng", "locationProvince", "skillsJson", "status", "title", "userId") SELECT "createdAt", "educationLevel", "functionLevel", "functionNameId", "functionNameLabel", "id", "languagesJson", "lastMatchedAt", "locationCity", "locationCountry", "locationLat", "locationLng", "locationProvince", "skillsJson", "status", "title", "userId" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE INDEX "Project_userId_idx" ON "Project"("userId");
CREATE TABLE "new_Reveal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eightvanceTalentId" INTEGER NOT NULL,
    "revealedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "creditCost" INTEGER NOT NULL DEFAULT 1,
    "piiPayloadEnc" TEXT NOT NULL,
    CONSTRAINT "Reveal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Reveal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Reveal_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Reveal" ("creditCost", "eightvanceTalentId", "expiresAt", "id", "piiPayloadEnc", "projectId", "revealedAt", "userId") SELECT "creditCost", "eightvanceTalentId", "expiresAt", "id", "piiPayloadEnc", "projectId", "revealedAt", "userId" FROM "Reveal";
DROP TABLE "Reveal";
ALTER TABLE "new_Reveal" RENAME TO "Reveal";
CREATE INDEX "Reveal_tenantId_eightvanceTalentId_expiresAt_idx" ON "Reveal"("tenantId", "eightvanceTalentId", "expiresAt");
CREATE INDEX "Reveal_projectId_idx" ON "Reveal"("projectId");
CREATE INDEX "Reveal_userId_idx" ON "Reveal"("userId");
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "emailVerifiedAt" DATETIME,
    "stripeCustomerId" TEXT,
    "currentPlanId" TEXT,
    "creditsBalance" INTEGER NOT NULL DEFAULT 0,
    "creditsPeriodEnd" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" DATETIME
);
INSERT INTO "new_User" ("createdAt", "creditsBalance", "creditsPeriodEnd", "currentPlanId", "email", "emailVerifiedAt", "id", "lastLoginAt", "name", "passwordHash", "role", "stripeCustomerId") SELECT "createdAt", "creditsBalance", "creditsPeriodEnd", "currentPlanId", "email", "emailVerifiedAt", "id", "lastLoginAt", "name", "passwordHash", "role", "stripeCustomerId" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ProjectPool_tenantId_idx" ON "ProjectPool"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectPool_projectId_tenantId_key" ON "ProjectPool"("projectId", "tenantId");
