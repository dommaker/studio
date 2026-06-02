-- Baseline: RequirementsDoc table was created via db push, shadow DB needs this
CREATE TABLE IF NOT EXISTS "RequirementsDoc" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "goalId" TEXT,
    "projectId" TEXT,
    "sourceChannelId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "linkedDocIds" TEXT NOT NULL DEFAULT '[]',
    "executionSummary" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RequirementsDoc_sourceChannelId_fkey" FOREIGN KEY ("sourceChannelId") REFERENCES "Channel" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "RequirementsDoc_status_idx" ON "RequirementsDoc"("status");
CREATE INDEX IF NOT EXISTS "RequirementsDoc_goalId_idx" ON "RequirementsDoc"("goalId");
CREATE INDEX IF NOT EXISTS "RequirementsDoc_sourceChannelId_idx" ON "RequirementsDoc"("sourceChannelId");
CREATE INDEX IF NOT EXISTS "RequirementsDoc_projectId_idx" ON "RequirementsDoc"("projectId");

-- AlterTable: add missing columns to RequirementsDoc
ALTER TABLE "RequirementsDoc" ADD COLUMN "acGroups" TEXT;    -- G34: JSON array of structured AC groups
ALTER TABLE "RequirementsDoc" ADD COLUMN "contractTests" TEXT; -- TDD-07: Analyst 契约测试
