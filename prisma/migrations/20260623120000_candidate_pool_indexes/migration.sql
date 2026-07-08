-- Composite indexes for the candidate pool-dedup + list hot paths (the other
-- hot-path indexes already exist: Match(projectId,score), CandidateJobMatch(runId),
-- Reveal(tenantId,eightvanceTalentId,expiresAt)).
CREATE INDEX "Candidate_tenantId_organizationId_eightvanceTalentId_idx" ON "Candidate"("tenantId", "organizationId", "eightvanceTalentId");
CREATE INDEX "Candidate_organizationId_status_idx" ON "Candidate"("organizationId", "status");
