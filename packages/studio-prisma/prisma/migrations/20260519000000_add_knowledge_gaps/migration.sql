-- CreateTable: UserPreference (G-001)
CREATE TABLE "UserPreference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL DEFAULT 'default',
    "preferredModel" TEXT,
    "modelUsageRatio" TEXT NOT NULL DEFAULT '{}',
    "downgradeAccepted" BOOLEAN NOT NULL DEFAULT false,
    "responseStyle" TEXT,
    "messageFrequency" REAL,
    "avgMessageLength" INTEGER,
    "preferredAgents" TEXT NOT NULL DEFAULT '[]',
    "autoApproveThreshold" REAL,
    "reviewRoundsTolerance" INTEGER,
    "favoriteTools" TEXT NOT NULL DEFAULT '[]',
    "toolRiskTolerance" TEXT,
    "activeHours" TEXT NOT NULL DEFAULT '[]',
    "avgSessionMinutes" INTEGER,
    "confidence" REAL NOT NULL DEFAULT 0.3,
    "lastInferredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "UserPreference_userId_idx" ON "UserPreference"("userId");

-- CreateTable: BusinessRule (G-002)
CREATE TABLE "BusinessRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "defaultValue" TEXT,
    "source" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "affects" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "lastExtractedAt" DATETIME,
    "lastVerifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "BusinessRule_category_status_idx" ON "BusinessRule"("category", "status");
CREATE INDEX "BusinessRule_name_idx" ON "BusinessRule"("name");

-- CreateTable: EnvironmentSnapshot (G-003)
CREATE TABLE "EnvironmentSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hostname" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "nodeVersion" TEXT NOT NULL,
    "cpuCores" INTEGER NOT NULL,
    "totalMemGB" REAL NOT NULL,
    "apiPort" INTEGER NOT NULL,
    "webPort" INTEGER NOT NULL,
    "nodeEnv" TEXT NOT NULL,
    "dbPath" TEXT NOT NULL,
    "nginxConfig" TEXT,
    "serviceManager" TEXT,
    "tunnelType" TEXT,
    "keyDependencies" TEXT NOT NULL DEFAULT '{}',
    "knownLimitations" TEXT NOT NULL DEFAULT '[]',
    "takenAt" DATETIME NOT NULL,
    "takenBy" TEXT NOT NULL DEFAULT 'auto',
    "diffFromPrev" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "EnvironmentSnapshot_takenAt_idx" ON "EnvironmentSnapshot"("takenAt");

-- CreateTable: DecisionChain (G-004)
CREATE TABLE "DecisionChain" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "topic" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "options" TEXT NOT NULL,
    "chosen" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "tradeoffs" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "participants" TEXT NOT NULL DEFAULT '[]',
    "voteDistribution" TEXT,
    "dissentNotes" TEXT,
    "revisable" BOOLEAN NOT NULL DEFAULT true,
    "revisitCondition" TEXT,
    "outcomeKnown" BOOLEAN NOT NULL DEFAULT false,
    "outcomeSummary" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "DecisionChain_category_idx" ON "DecisionChain"("category");
CREATE INDEX "DecisionChain_sourceType_idx" ON "DecisionChain"("sourceType");
CREATE INDEX "DecisionChain_topic_idx" ON "DecisionChain"("topic");

-- CreateTable: InteractionPattern (G-005)
CREATE TABLE "InteractionPattern" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "frequency" REAL NOT NULL,
    "confidence" REAL NOT NULL,
    "insight" TEXT NOT NULL,
    "suggestion" TEXT,
    "observedPeriodStart" DATETIME NOT NULL,
    "observedPeriodEnd" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "InteractionPattern_category_status_idx" ON "InteractionPattern"("category", "status");
CREATE INDEX "InteractionPattern_confidence_idx" ON "InteractionPattern"("confidence");
