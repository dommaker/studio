-- AS-020 P1-01: Channel conversation mode fields

-- Baseline: Channel table was created via db push, shadow DB needs this
CREATE TABLE IF NOT EXISTS "Channel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'rnd',
    "discordChannelId" TEXT,
    "discordWebhookUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "Channel_name_key" ON "Channel"("name");

ALTER TABLE "Channel" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'broadcast';
ALTER TABLE "Channel" ADD COLUMN "agentName" TEXT;
ALTER TABLE "Channel" ADD COLUMN "sessionId" TEXT;
ALTER TABLE "Channel" ADD COLUMN "defaultWorkspaceId" TEXT;
ALTER TABLE "Channel" ADD COLUMN "defaultPath" TEXT;
