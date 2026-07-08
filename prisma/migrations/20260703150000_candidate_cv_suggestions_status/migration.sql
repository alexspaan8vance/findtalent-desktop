-- Lifecycle of the 8vance CV-reparse suggestion pass: "pending" (reparse not
-- surfaced yet), "ready" (suggestions exist), "none" (parse landed, nothing to
-- add), "error". Lets the UI distinguish "still analysing" from "done, nothing
-- found". Nullable, defaults to NULL for legacy rows.
ALTER TABLE "Candidate" ADD COLUMN "cvSuggestionsStatus" TEXT;
