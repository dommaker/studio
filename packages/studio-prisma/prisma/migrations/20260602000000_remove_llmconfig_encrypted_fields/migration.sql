-- P9-01: Remove encrypted API key fields from LLMConfig.
-- API keys are now resolved via config.env + getProviderApiKey() (B15).

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LLMConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "baseUrl" TEXT,
    "model" TEXT NOT NULL,
    "options" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_LLMConfig" ("baseUrl", "createdAt", "id", "isActive", "model", "options", "provider", "scope", "updatedAt") SELECT "baseUrl", "createdAt", "id", "isActive", "model", "options", "provider", "scope", "updatedAt" FROM "LLMConfig";
DROP TABLE "LLMConfig";
ALTER TABLE "new_LLMConfig" RENAME TO "LLMConfig";
CREATE UNIQUE INDEX "LLMConfig_scope_provider_key" ON "LLMConfig"("scope", "provider");
CREATE INDEX "LLMConfig_scope_idx" ON "LLMConfig"("scope");
CREATE INDEX "LLMConfig_isActive_idx" ON "LLMConfig"("isActive");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
