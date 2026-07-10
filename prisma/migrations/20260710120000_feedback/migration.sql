-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "userEmail" TEXT,
    "category" TEXT NOT NULL DEFAULT 'bug',
    "message" TEXT NOT NULL,
    "pageUrl" TEXT,
    "appVersion" TEXT,
    "userAgent" TEXT,
    "targetText" TEXT,
    "targetHref" TEXT,
    "targetSelector" TEXT,
    "screenshot" TEXT,
    "delivered" BOOLEAN NOT NULL DEFAULT false,
    "deliveryError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Feedback_createdAt_idx" ON "Feedback"("createdAt");

-- CreateIndex
CREATE INDEX "Feedback_userId_idx" ON "Feedback"("userId");
