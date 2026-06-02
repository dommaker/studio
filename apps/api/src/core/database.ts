// 数据库连接 - 统一使用 studio-prisma 单例
import { execSync } from 'child_process';
import { resolve } from 'path';

// 解析 DATABASE_URL 为绝对路径（必须在 Prisma Client 初始化前）
// Prisma 运行时从 CWD 解析 file:./data.db，不同启动目录会读到不同 DB
const prismaDir = resolve(__dirname, '../../../../packages/studio-prisma');
if (!process.env.DATABASE_URL || process.env.DATABASE_URL.startsWith('file:./')) {
  process.env.DATABASE_URL = `file:${prismaDir}/prisma/data.db`;
}

// CJS require: 不 hoist，确保上面的 env 设置先执行
const { prisma } = require('@dommaker/studio-prisma') as typeof import('@dommaker/studio-prisma');
const { skillLoader } = require('@dommaker/studio-skill') as typeof import('@dommaker/studio-skill');
const { logger } = require('../utils/logger.js') as typeof import('../utils/logger.js');
export { prisma };

async function autoMigrate(): Promise<void> {
  const prismaDir = resolve(__dirname, '../../../../packages/studio-prisma');
  const dbUrl = process.env.DATABASE_URL || `file:${prismaDir}/prisma/data.db`;
  try {
    const out = execSync(`npx prisma migrate deploy`, {
      cwd: prismaDir,
      env: { ...process.env, DATABASE_URL: dbUrl },
      encoding: 'utf-8',
      timeout: 15000,
    });
    if (out.includes('have been applied')) {
      logger.info('[DB] Prisma migrations applied');
    }
  } catch (e: unknown) {
    // migrate deploy exits 0 when nothing to apply, non-zero on real error
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('No pending migrations')) {
      logger.warn({ err: msg }, '[DB] Migration warning (non-blocking)');
    }
  }
}

export async function connectDatabase(): Promise<void> {
  try {
    // 先迁移再连接
    await autoMigrate();
    await prisma.$connect();
    logger.info('Database connected successfully');

    // Init SkillLoader with Prisma for DB-backed skill loading
    skillLoader.init(prisma);
  } catch (error) {
    logger.error({ err: error }, 'Failed to connect to database');
    throw error;
  }
}
