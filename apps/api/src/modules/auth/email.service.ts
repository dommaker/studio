/**
 * 邮件服务 - Email Service
 * 处理密码重置邮件发送
 */
import { logger } from '@dommaker/studio-shared';

/**
 * 发送密码重置邮件
 * 开发环境输出重置链接到日志，生产环境需接入 SMTP 邮件服务
 *
 * FRONTEND_URL 在调用时读取，便于测试动态切换环境变量
 */
export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const resetUrl = `${frontendUrl}/reset-password?token=${token}`;

  if (process.env.NODE_ENV === 'production') {
    // TODO: 接入真实 SMTP 邮件服务
    logger.info(`[EMAIL] Password reset for ${email}: ${resetUrl}`);
  } else {
    logger.info(`[DEV EMAIL] Password reset for ${email}: ${resetUrl}`);
  }
}
