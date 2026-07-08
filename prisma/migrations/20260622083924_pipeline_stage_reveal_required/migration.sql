-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PipelineStage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "color" TEXT NOT NULL DEFAULT '#1f6f5c',
    "isTerminal" BOOLEAN NOT NULL DEFAULT false,
    "revealRequired" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PipelineStage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PipelineStage" ("color", "createdAt", "id", "isTerminal", "name", "organizationId", "position") SELECT "color", "createdAt", "id", "isTerminal", "name", "organizationId", "position" FROM "PipelineStage";
-- Backfill the reveal-gate flag from each row's CURRENT order position relative
-- to the seed-time shortlist boundary (SHORTLIST_BOUNDARY_INDEX = 2): the two
-- pre-reveal stages (position < 2 → inflow + shortlist) are not gated; every
-- stage at position >= 2 keeps the column default (revealRequired = true).
UPDATE "new_PipelineStage" SET "revealRequired" = false WHERE "position" < 2;
DROP TABLE "PipelineStage";
ALTER TABLE "new_PipelineStage" RENAME TO "PipelineStage";
CREATE INDEX "PipelineStage_organizationId_position_idx" ON "PipelineStage"("organizationId", "position");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
