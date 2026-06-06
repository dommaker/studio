-- AlterTable
ALTER TABLE "PipelineRun" ADD COLUMN "goalId" TEXT;

-- CreateIndex
CREATE INDEX "PipelineRun_goalId_idx" ON "PipelineRun"("goalId");
