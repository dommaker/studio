-- B9-017: Delete CompanySkill model + add Skill execution fields

-- Drop CompanySkill table
DROP TABLE IF EXISTS "company_skill";

-- Add new fields to Skill table
ALTER TABLE "Skill" ADD COLUMN "prompt" TEXT;
ALTER TABLE "Skill" ADD COLUMN "trigger" TEXT;
ALTER TABLE "Skill" ADD COLUMN "agentTypes" TEXT;
ALTER TABLE "Skill" ADD COLUMN "tier" TEXT;
ALTER TABLE "Skill" ADD COLUMN "tools" TEXT;
ALTER TABLE "Skill" ADD COLUMN "isBuiltin" BOOLEAN NOT NULL DEFAULT false;
