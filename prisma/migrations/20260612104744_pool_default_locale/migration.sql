-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Tenant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "eightvanceClientId" TEXT NOT NULL,
    "eightvanceClientSecretEnc" TEXT NOT NULL,
    "eightvanceCompanyId" INTEGER NOT NULL,
    "stripeAccountId" TEXT,
    "brandConfigJson" JSONB NOT NULL,
    "defaultLocale" TEXT NOT NULL DEFAULT 'en',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Tenant" ("brandConfigJson", "createdAt", "eightvanceClientId", "eightvanceClientSecretEnc", "eightvanceCompanyId", "id", "name", "slug", "stripeAccountId", "updatedAt") SELECT "brandConfigJson", "createdAt", "eightvanceClientId", "eightvanceClientSecretEnc", "eightvanceCompanyId", "id", "name", "slug", "stripeAccountId", "updatedAt" FROM "Tenant";
DROP TABLE "Tenant";
ALTER TABLE "new_Tenant" RENAME TO "Tenant";
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
