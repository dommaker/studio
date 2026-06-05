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
export { prisma };

// 懒加载（避免 ESM .js 解析问题影响不需要这些模块的测试）
let _logger: typeof import('../utils/logger').logger | undefined;
let _skillLoader: typeof import('@dommaker/studio-skill').skillLoader | undefined;

function getLogger() {
  if (!_logger) {
    _logger = (require('../utils/logger') as typeof import('../utils/logger')).logger;
  }
  return _logger;
}

function getSkillLoader() {
  if (!_skillLoader) {
    _skillLoader = (require('@dommaker/studio-skill') as typeof import('@dommaker/studio-skill')).skillLoader;
  }
  return _skillLoader;
}

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
      getLogger().info('[DB] Prisma migrations applied');
    }
  } catch (e: unknown) {
    // migrate deploy exits 0 when nothing to apply, non-zero on real error
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes('No pending migrations')) {
      getLogger().warn({ err: msg }, '[DB] Migration warning (non-blocking)');
    }
  }
}

export async function connectDatabase(): Promise<void> {
  try {
    // 先迁移再连接
    await autoMigrate();
    await prisma.$connect();
    getLogger().info('Database connected successfully');

    // Init SkillLoader with Prisma for DB-backed skill loading
    getSkillLoader().init(prisma);
  } catch (error) {
    getLogger().error({ err: error }, 'Failed to connect to database');
    throw error;
  }
}
