-- Single-flight guard for syncCandidateToVance: prevents a racing/lagging second
-- sync from creating a duplicate 8vance talent. Nullable, defaults to NULL.
ALTER TABLE "Candidate" ADD COLUMN "syncStartedAt" DATETIME;
