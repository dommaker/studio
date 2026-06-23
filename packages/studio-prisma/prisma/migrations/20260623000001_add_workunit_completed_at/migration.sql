-- AlterTable: Add completedAt to work_unit
-- Maps to GoalExecution.completedAt / Goal.completedAt
-- Written when WorkUnit reaches terminal state (done or closed).

ALTER TABLE "work_unit" ADD COLUMN "completedAt" DATETIME;
