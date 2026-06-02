-- B9-017: Delete CompanySkill model + add Skill execution fields

-- Drop CompanySkill table
DROP TABLE IF EXISTS "company_skill";

-- Baseline: Skill table was created via db push, shadow DB needs this
CREATE TABLE IF NOT EXISTS "Skill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "roleId" TEXT,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'extraction',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "category" TEXT,
    "description" TEXT,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "successRate" REAL NOT NULL DEFAULT 0,
    "avgDuration" REAL NOT NULL DEFAULT 0,
    "metadata" TEXT,
    "extractedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Skill_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Skill_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "Skill_companyId_name_key" ON "Skill"("companyId", "name");

-- Add new fields to Skill table
ALTER TABLE "Skill" ADD COLUMN "prompt" TEXT;
ALTER TABLE "Skill" ADD COLUMN "trigger" TEXT;
ALTER TABLE "Skill" ADD COLUMN "agentTypes" TEXT;
ALTER TABLE "Skill" ADD COLUMN "tier" TEXT;
ALTER TABLE "Skill" ADD COLUMN "tools" TEXT;
ALTER TABLE "Skill" ADD COLUMN "isBuiltin" BOOLEAN NOT NULL DEFAULT false;
