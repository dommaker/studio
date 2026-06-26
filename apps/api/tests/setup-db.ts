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

// Don't recreate if DB already exists — vitest runs setup once per session
// with maxConcurrency: 1.
if (!existsSync(dbPath)) {
  // Delete stale journal files to avoid SQLITE_READONLY_DBMOVED.
  try { unlinkSync(dbPath); } catch { /* ignore */ }
  try { unlinkSync(dbPath + '-journal'); } catch { /* ignore */ }
  try { unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }

  // Use db push to create a fresh DB from schema.
  // --force-reset drops all data and recreates from schema (safe since we deleted the file).
  const prismaBin = resolve(__dirname, '../node_modules/.bin/prisma');
  execSync(`${prismaBin} db push --force-reset --accept-data-loss --schema ${schemaPath}`, {
    cwd: prismaDir,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    timeout: 60_000,
  });
}
