-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "emailVerifiedAt" DATETIME,
    "stripeCustomerId" TEXT,
    "currentPlanId" TEXT,
    "creditsBalance" INTEGER NOT NULL DEFAULT 0,
    "purchasedCredits" INTEGER NOT NULL DEFAULT 0,
    "creditsPeriodEnd" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" DATETIME
);
INSERT INTO "new_User" ("createdAt", "creditsBalance", "creditsPeriodEnd", "currentPlanId", "email", "emailVerifiedAt", "id", "lastLoginAt", "name", "passwordHash", "role", "stripeCustomerId") SELECT "createdAt", "creditsBalance", "creditsPeriodEnd", "currentPlanId", "email", "emailVerifiedAt", "id", "lastLoginAt", "name", "passwordHash", "role", "stripeCustomerId" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
