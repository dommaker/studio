-- Drop data-layer tables (jsonl-append migration)
DROP TABLE IF EXISTS "AuditLog";
DROP TABLE IF EXISTS "StudioEvent";
DROP TABLE IF EXISTS "Execution";
DROP TABLE IF EXISTS "Notification";
DROP TABLE IF EXISTS "Incident";
DROP TABLE IF EXISTS "KRHistory";
DROP TABLE IF EXISTS "EnvironmentSnapshot";

-- Drop config-layer tables
DROP TABLE IF EXISTS "Environment";
DROP TABLE IF EXISTS "Agent";
DROP TABLE IF EXISTS "AgentConfig";
DROP TABLE IF EXISTS "AgentConfigVersion";
DROP TABLE IF EXISTS "Capability";

-- Drop knowledge-layer tables
DROP TABLE IF EXISTS "Resolution";

-- Drop OKR table
DROP TABLE IF EXISTS "OKR";
