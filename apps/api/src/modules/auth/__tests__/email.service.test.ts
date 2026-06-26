/**
 * Email service unit tests
 *
 * Covers:
 * - sendPasswordResetEmail logs reset link in dev mode
 * - sendPasswordResetEmail uses production format
 * - custom FRONTEND_URL support
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLoggerInfo = vi.fn();

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: mockLoggerInfo },
}));

describe('sendPasswordResetEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.FRONTEND_URL;
    delete process.env.NODE_ENV;
  });

  it('logs reset link in dev mode with default frontend URL', async () => {
    const { sendPasswordResetEmail } = await import('../email.service.js');

    await sendPasswordResetEmail('user@test.com', 'token-123');

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      '[DEV EMAIL] Password reset for user@test.com: http://localhost:5173/reset-password?token=token-123'
    );
  });

  it('uses production log format when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    const { sendPasswordResetEmail } = await import('../email.service.js');

    await sendPasswordResetEmail('prod@test.com', 'prod-token');

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      '[EMAIL] Password reset for prod@test.com: http://localhost:5173/reset-password?token=prod-token'
    );
  });

  it('uses custom FRONTEND_URL when set', async () => {
    process.env.FRONTEND_URL = 'https://myapp.example.com';
    const { sendPasswordResetEmail } = await import('../email.service.js');

    await sendPasswordResetEmail('test@test.com', 'abc');

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      '[DEV EMAIL] Password reset for test@test.com: https://myapp.example.com/reset-password?token=abc'
    );
  });
});
