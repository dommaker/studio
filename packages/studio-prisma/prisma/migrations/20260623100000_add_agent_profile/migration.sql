-- CreateTable
CREATE TABLE "agent_profile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "channels" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_profile_name_key" ON "agent_profile"("name");

-- CreateIndex
CREATE INDEX "agent_profile_status_idx" ON "agent_profile"("status");
