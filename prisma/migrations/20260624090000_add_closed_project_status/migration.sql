-- Add CLOSED to the ProjectStatus enum.
--
-- SQLite has no native ENUM type: Prisma enums are persisted as plain TEXT
-- columns (see the `init` migration — `"status" TEXT NOT NULL DEFAULT 'DRAFT'`),
-- and the enum is enforced in the Prisma client, not by a DB CHECK constraint.
-- Adding a new enum value therefore requires NO schema change on SQLite — this
-- migration is an intentional no-op that records the enum extension in history.
--
-- On Postgres this would be: ALTER TYPE "ProjectStatus" ADD VALUE 'CLOSED';
SELECT 1;
