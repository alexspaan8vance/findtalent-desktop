-- Pending/approved/dismissed "richer-wins" CV suggestions (8vance parse proposing
-- over our local parse, for human approval). Holds a CvSuggestion[] JSON list.
-- Nullable, defaults to NULL.
ALTER TABLE "Candidate" ADD COLUMN "cvSuggestionsJson" JSONB;
