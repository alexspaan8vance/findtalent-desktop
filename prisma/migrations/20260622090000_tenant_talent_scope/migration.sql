-- AlterTable: add per-pool project→talent matching scope.
-- "FULL" (default) preserves the historical all-sources behaviour; "LOCAL"
-- restricts matching to the pool's own talent source. Constant default → a
-- plain ADD COLUMN is safe on SQLite.
ALTER TABLE "Tenant" ADD COLUMN "talentScope" TEXT NOT NULL DEFAULT 'FULL';
