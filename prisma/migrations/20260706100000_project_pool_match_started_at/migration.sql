-- When a ProjectPool most recently ENTERED the MATCHING state. Unlike
-- lastMatchedAt (only updated on success), this lets a stale-sweep recover a
-- pool whose 8vance async task never completed / whose executor died, so a
-- project never spins "Matching…" forever. Nullable; legacy rows are NULL and
-- treated as stale by the sweep.
ALTER TABLE "ProjectPool" ADD COLUMN "matchStartedAt" DATETIME;
