-- OBS-2: PipelineReview table for persisting review results
CREATE TABLE "pipeline_review" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "executionId" TEXT NOT NULL UNIQUE,
    "goalId" TEXT,
    "overallApproved" BOOLEAN NOT NULL DEFAULT false,
    "score" INTEGER,
    "stanceCount" INTEGER NOT NULL DEFAULT 0,
    "stancesJson" TEXT NOT NULL,
    "issuesJson" TEXT NOT NULL,
    "summary" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "pipeline_review_goalId_idx" ON "pipeline_review"("goalId");
CREATE INDEX "pipeline_review_createdAt_idx" ON "pipeline_review"("createdAt");

-- OBS-6: PipelineDecision table for persisting routing decisions
CREATE TABLE "pipeline_decision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "executionId" TEXT NOT NULL UNIQUE,
    "goalId" TEXT,
    "tier" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "acCount" INTEGER NOT NULL DEFAULT 0,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "taskCategory" TEXT,
    "riskHits" INTEGER NOT NULL DEFAULT 0,
    "estimatedLines" INTEGER,
    "featuresJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "pipeline_decision_goalId_idx" ON "pipeline_decision"("goalId");
CREATE INDEX "pipeline_decision_createdAt_idx" ON "pipeline_decision"("createdAt");
