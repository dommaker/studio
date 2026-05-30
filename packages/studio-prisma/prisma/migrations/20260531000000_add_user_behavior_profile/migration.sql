-- KE-003: User behavior distillation profiles

CREATE TABLE "user_behavior_profile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "suggestedAction" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "alreadyCovered" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "user_behavior_profile_sessionId_idx" ON "user_behavior_profile"("sessionId");
CREATE INDEX "user_behavior_profile_category_idx" ON "user_behavior_profile"("category");
CREATE INDEX "user_behavior_profile_status_idx" ON "user_behavior_profile"("status");
CREATE INDEX "user_behavior_profile_createdAt_idx" ON "user_behavior_profile"("createdAt");
