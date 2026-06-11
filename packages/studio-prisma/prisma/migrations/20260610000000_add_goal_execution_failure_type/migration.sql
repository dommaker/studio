-- AlterTable
ALTER TABLE "GoalExecution" ADD COLUMN "failureType" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "GoalExecution_failureType_idx" ON "GoalExecution"("failureType");
