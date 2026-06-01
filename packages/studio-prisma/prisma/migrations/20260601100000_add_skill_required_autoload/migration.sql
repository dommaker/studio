-- S-001: Add required (dependency list) and autoLoad fields to Skill

ALTER TABLE "Skill" ADD COLUMN "required" TEXT;
ALTER TABLE "Skill" ADD COLUMN "autoLoad" BOOLEAN NOT NULL DEFAULT false;
