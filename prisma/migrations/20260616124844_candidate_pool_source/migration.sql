-- AlterTable
ALTER TABLE "CandidateJobMatch" ADD COLUMN "employerCompanyId" INTEGER;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN "eightvanceBaseUrl" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "ownSourceSlug" TEXT;
