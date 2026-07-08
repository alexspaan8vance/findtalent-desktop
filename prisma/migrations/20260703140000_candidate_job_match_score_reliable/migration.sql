-- Whether CandidateJobMatch.score is trustworthy to SHOW as a percentage.
-- `/match/job/` returns a degenerate score:1 for cross-company jobs the tenant
-- doesn't own (→ fake 100% on the candidate match list). Own-pool rows are
-- reliable; cross-company rows are set false at insert so the UI hides the %
-- until the real /match/specific score is fetched on detail-open. Defaults to
-- true so pre-existing rows are unaffected until their next re-match.
ALTER TABLE "CandidateJobMatch" ADD COLUMN "scoreReliable" BOOLEAN NOT NULL DEFAULT true;
