-- G30: Unified StudioEvent Table
-- Run manually before Prisma migration: npx prisma db execute --file migration.sql

CREATE TABLE IF NOT EXISTS "StudioEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "StudioEvent_type_idx" ON "StudioEvent"("type");
CREATE INDEX IF NOT EXISTS "StudioEvent_timestamp_idx" ON "StudioEvent"("timestamp");
