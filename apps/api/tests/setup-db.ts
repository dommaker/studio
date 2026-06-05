/**
 * Vitest setupFiles — create test DB schema in the same process before tests.
 * Uses a per-worker DB file to avoid SQLite concurrent write conflicts.
 */
import { execSync } from 'child_process';
import { resolve } from 'path';
import { existsSync, statSync } from 'fs';
import { randomBytes } from 'crypto';

// Use per-worker DB if not explicitly set (avoids concurrent write conflicts)
if (!process.env.DATABASE_URL || process.env.DATABASE_URL === 'file:/tmp/studio-test.db') {
  const id = randomBytes(4).toString('hex');
  process.env.DATABASE_URL = `file:/tmp/studio-test-${id}.db`;
}

const dbUrl = process.env.DATABASE_URL;
const dbPath = dbUrl.replace('file:', '');
const prismaDir = resolve(__dirname, '../../../packages/studio-prisma');

// Only push if DB doesn't exist or is empty (< 1KB)
if (!existsSync(dbPath) || statSync(dbPath).size < 1024) {
  execSync('npx prisma db push --skip-generate', {
    cwd: prismaDir,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
    timeout: 30_000,
  });
}
