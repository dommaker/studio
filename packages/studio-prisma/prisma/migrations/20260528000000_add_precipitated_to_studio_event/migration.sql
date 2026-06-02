-- CreateTable (baseline: StudioEvent was created via db push, shadow DB needs this)
CREATE TABLE IF NOT EXISTS "StudioEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" TEXT NOT NULL,
    "executionId" TEXT,
    "agentRole" TEXT,
    "modelTier" TEXT,
    "modelName" TEXT,
    "stage" TEXT,
    "sessionCount" INTEGER,
    "isContinued" BOOLEAN,
    "durationMs" INTEGER,
    "numTurns" INTEGER,
    "promptSize" INTEGER,
    "tokenInput" INTEGER,
    "tokenOutput" INTEGER,
    "tokenCacheRead" INTEGER,
    "tokenCacheWrite" INTEGER,
    "costUsd" REAL,
    "serviceTier" TEXT,
    "constraintHash" TEXT,
    "constraintSize" INTEGER,
    "precipitated" BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS "StudioEvent_type_idx" ON "StudioEvent"("type");
CREATE INDEX IF NOT EXISTS "StudioEvent_timestamp_idx" ON "StudioEvent"("timestamp");
CREATE INDEX IF NOT EXISTS "StudioEvent_executionId_idx" ON "StudioEvent"("executionId");
CREATE INDEX IF NOT EXISTS "StudioEvent_agentRole_idx" ON "StudioEvent"("agentRole");
