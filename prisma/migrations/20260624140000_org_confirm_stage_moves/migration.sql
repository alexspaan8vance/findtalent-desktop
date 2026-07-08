-- Pipeline stage-change confirmation toggle (owner-controlled, default on).

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN "confirmStageMoves" BOOLEAN NOT NULL DEFAULT true;
