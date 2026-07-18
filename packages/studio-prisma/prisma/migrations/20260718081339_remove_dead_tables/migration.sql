-- Drop dead tables (Spec 1: Dead Code Cleanup)
-- AC-1: SignedDocument already removed in prior migration
-- AC-2: OAuthAccount — remove OAuth support (local mode only)
-- AC-3: PasswordResetToken + EmailVerificationToken — remove password reset/email verification
-- AC-6: Company — remove multi-tenant legacy

-- DropTables
DROP TABLE IF EXISTS "OAuthAccount";
DROP TABLE IF EXISTS "PasswordResetToken";
DROP TABLE IF EXISTS "EmailVerificationToken";
DROP TABLE IF EXISTS "Company";
