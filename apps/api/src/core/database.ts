// 数据库连接 - 统一使用 studio-prisma 单例
export { prisma } from '@dommaker/studio-prisma';
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '../utils/logger.js';

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    logger.info('Database connected successfully');
  } catch (error) {
    logger.error({ err: error }, 'Failed to connect to database');
    throw error;
  }
}
