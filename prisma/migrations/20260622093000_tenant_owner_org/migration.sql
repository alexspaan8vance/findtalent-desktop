-- AlterTable: add the org that owns a pool's intake. Public self-registration
-- (/apply/[slug]) assigns new applicants to this org. Nullable loose scalar
-- (no FK, mirroring Candidate.createdByUserId) → a plain ADD COLUMN is safe.
ALTER TABLE "Tenant" ADD COLUMN "ownerOrganizationId" TEXT;
