-- B9-025: Add workflow pattern fields to UserPreference

ALTER TABLE "UserPreference" ADD COLUMN "workflowDistribution" TEXT;
ALTER TABLE "UserPreference" ADD COLUMN "recurringWorkflows" TEXT;
ALTER TABLE "UserPreference" ADD COLUMN "preferredWorkflowTypes" TEXT;
