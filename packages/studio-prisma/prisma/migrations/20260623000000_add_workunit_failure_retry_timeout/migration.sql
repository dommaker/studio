-- AlterTable: Add failureType, retryCount, timeoutAt to work_unit
-- These fields are promoted from GoalExecution to first-class columns
-- for Monitor high-frequency query performance (indexed, not in metadata JSON).

ALTER TABLE "work_unit" ADD COLUMN "failureType" TEXT;
ALTER TABLE "work_unit" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "work_unit" ADD COLUMN "timeoutAt" DATETIME;

-- CreateIndex
CREATE INDEX "work_unit_failureType_idx" ON "work_unit"("failureType");

-- CreateIndex
CREATE INDEX "work_unit_timeoutAt_idx" ON "work_unit"("timeoutAt");
