-- CreateTable: Resolution (RKB Phase 1)
CREATE TABLE "Resolution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pattern" TEXT NOT NULL,
    "errorClass" TEXT NOT NULL,
    "layer" TEXT NOT NULL DEFAULT 'L5_error_fix',
    "title" TEXT NOT NULL DEFAULT '',
    "fix" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "verifyCount" INTEGER NOT NULL DEFAULT 0,
    "verifiedAt" DATETIME,
    "sourceGoalId" TEXT,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "Resolution_errorClass_idx" ON "Resolution"("errorClass");
CREATE INDEX "Resolution_layer_idx" ON "Resolution"("layer");
CREATE INDEX "Resolution_status_idx" ON "Resolution"("status");
CREATE INDEX "Resolution_verifyCount_idx" ON "Resolution"("verifyCount");
