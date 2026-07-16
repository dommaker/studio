-- Remove AN runtime models migrated to file storage
-- ChannelMessage depends on Channel via FK
DROP TABLE IF EXISTS "ChannelMessage";
DROP TABLE IF EXISTS "RequirementsDoc";
DROP TABLE IF EXISTS "work_unit";
DROP TABLE IF EXISTS "Channel";
DROP TABLE IF EXISTS "agent_profile";
DROP TABLE IF EXISTS "runtime_instance";
