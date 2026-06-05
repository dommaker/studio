/**
 * Vitest setupFiles — create test DB schema before tests run.
 * Uses a fixed path so all imports resolve to the same DB.
 */
import { execSync } from 'child_process';
import { resolve } from 'path';
import { existsSync, statSync } from 'fs';

// Fixed test DB path — must be set BEFORE any Prisma import
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'file:/tmp/studio-test.db';
}

const dbUrl = process.env.DATABASE_URL;
const dbPath = dbUrl.replace('file:', '');
const prismaDir = resolve(__dirname, '../../../packages/studio-prisma');

// Only create schema if DB doesn't exist or is empty (< 1KB).
// Use --force-reset for initial creation (drops+recreates all tables).
// After creation, the prisma CLI process exits, releasing all file handles.
// The test process will create its own PrismaClient pointing to the same file.
if (!existsSync(dbPath) || statSync(dbPath).size < 1024) {
  execSync('npx prisma db push --skip-generate --force-reset', {
    cwd: prismaDir,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    timeout: 30_000,
  });
}
