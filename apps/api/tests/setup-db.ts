/**
 * Vitest setupFiles — create test DB schema before tests run.
 * Uses a fixed path so all imports resolve to the same DB.
 */
import { execSync } from 'child_process';
import { resolve } from 'path';
import { existsSync, unlinkSync, mkdirSync } from 'fs';

// Fixed test DB path — must be set BEFORE any Prisma import.
// ALWAYS override: .env may set "file:./data.db" (relative to CWD),
// and --force-reset would destroy the production DB.
const testDbDir = resolve(__dirname, '../.test-data');
try { mkdirSync(testDbDir, { recursive: true }); } catch { /* exists */ }
const testDbPath = resolve(testDbDir, 'test.db');
process.env.DATABASE_URL = `file:${testDbPath}`;

const dbUrl = process.env.DATABASE_URL;
const dbPath = testDbPath;
const prismaDir = resolve(__dirname, '../../../packages/studio-prisma');
const schemaPath = resolve(prismaDir, 'prisma/schema.prisma');

// Always recreate test DB to ensure schema is in sync.
// Delete first to avoid SQLITE_READONLY_DBMOVED from stale file descriptors.
try { unlinkSync(dbPath); } catch { /* ignore if not exists */ }
try { unlinkSync(dbPath + '-journal'); } catch { /* ignore */ }
try { unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }

// Use db push WITHOUT --force-reset to avoid file replacement race condition.
// Since we deleted the file above, db push will create a fresh DB.
execSync(`npx prisma db push --skip-generate --schema ${schemaPath}`, {
  cwd: prismaDir,
  env: { ...process.env, DATABASE_URL: dbUrl },
  stdio: 'pipe',
  timeout: 30_000,
});
