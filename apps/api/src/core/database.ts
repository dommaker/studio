// 数据库连接 - 统一使用 studio-prisma 单例
export { prisma } from '@dommaker/studio-prisma';
import { prisma } from '@dommaker/studio-prisma';
import { skillLoader } from '@dommaker/studio-skill';
import { logger } from '../utils/logger.js';
import { execSync } from 'child_process';
import { resolve } from 'path';

async function autoMigrate(): Promise<void> {
  const prismaDir = resolve(__dirname, '../../../packages/studio-prisma');
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
