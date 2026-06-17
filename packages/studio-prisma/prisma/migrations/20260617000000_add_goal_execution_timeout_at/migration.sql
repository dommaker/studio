-- B57-P1: per-phase timeout marker for GoalExecution
ALTER TABLE "GoalExecution" ADD COLUMN "timeoutAt" DATETIME;
