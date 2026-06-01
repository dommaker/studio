-- AS-020 P1-01: Channel conversation mode fields

ALTER TABLE "Channel" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'broadcast';
ALTER TABLE "Channel" ADD COLUMN "agentName" TEXT;
ALTER TABLE "Channel" ADD COLUMN "sessionId" TEXT;
ALTER TABLE "Channel" ADD COLUMN "defaultWorkspaceId" TEXT;
ALTER TABLE "Channel" ADD COLUMN "defaultPath" TEXT;
