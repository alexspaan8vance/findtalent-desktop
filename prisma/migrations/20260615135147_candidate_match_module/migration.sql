-- CreateTable
CREATE TABLE "Candidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'nl',
    "cvFileKey" TEXT,
    "cvText" TEXT,
    "eightvanceTalentId" INTEGER,
    "profileJson" JSONB,
    "preferencesJson" JSONB,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "portalToken" TEXT,
    "portalTokenExpires" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CandidateMatchRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "sourcesJson" JSONB NOT NULL,
    "filtersJson" JSONB,
    "taskId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "CandidateMatchRun_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "Candidate" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CandidateJobMatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "eightvanceJobId" INTEGER NOT NULL,
    "score" REAL NOT NULL,
    "title" TEXT NOT NULL,
    "employerName" TEXT,
    "source" TEXT,
    "contractType" TEXT,
    "locationCity" TEXT,
    "locationLabel" TEXT,
    "isStaffingAgency" BOOLEAN NOT NULL DEFAULT false,
    "agencyScore" REAL NOT NULL DEFAULT 0,
    "agencyReasonsJson" JSONB,
    "hiddenByFilter" BOOLEAN NOT NULL DEFAULT false,
    "payloadJson" JSONB,
    CONSTRAINT "CandidateJobMatch_runId_fkey" FOREIGN KEY ("runId") REFERENCES "CandidateMatchRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StaffingAgencyRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT,
    "kind" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "label" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Candidate_portalToken_key" ON "Candidate"("portalToken");

-- CreateIndex
CREATE INDEX "Candidate_organizationId_idx" ON "Candidate"("organizationId");

-- CreateIndex
CREATE INDEX "Candidate_createdByUserId_idx" ON "Candidate"("createdByUserId");

-- CreateIndex
CREATE INDEX "Candidate_eightvanceTalentId_idx" ON "Candidate"("eightvanceTalentId");

-- CreateIndex
CREATE INDEX "CandidateMatchRun_candidateId_idx" ON "CandidateMatchRun"("candidateId");

-- CreateIndex
CREATE INDEX "CandidateJobMatch_runId_idx" ON "CandidateJobMatch"("runId");

-- CreateIndex
CREATE INDEX "CandidateJobMatch_runId_isStaffingAgency_idx" ON "CandidateJobMatch"("runId", "isStaffingAgency");

-- CreateIndex
CREATE INDEX "StaffingAgencyRule_organizationId_kind_enabled_idx" ON "StaffingAgencyRule"("organizationId", "kind", "enabled");
