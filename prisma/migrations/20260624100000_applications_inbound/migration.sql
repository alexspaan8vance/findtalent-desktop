-- Inbound applications: free application reveals + the "Gesolliciteerd" badge.

-- AlterTable
ALTER TABLE "Reveal" ADD COLUMN "source" TEXT;

-- AlterTable
ALTER TABLE "ShortlistEntry" ADD COLUMN "appliedAt" DATETIME;
