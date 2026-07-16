-- AlterTable: Add members to Channel
ALTER TABLE "Channel" ADD COLUMN "members" TEXT NOT NULL DEFAULT '[]';

-- AlterTable: Add projectPath to WorkUnit
ALTER TABLE "work_unit" ADD COLUMN "projectPath" TEXT;
