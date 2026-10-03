/**
 * DiscordNotifier 凭证安全测试：
 * 1. 测试环境默认不读用户真实 openclaw 配置（防生产 token 进测试进程）
 * 2. curl 兜底失败的错误日志不得回显 argv（execFile error.message 含完整命令行 → 只记 code/signal）
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const SECRET = 'SECRET_BOT_TOKEN_FOR_TEST';

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

import { DiscordNotifier } from '../discord-notifier.js';
import { logger } from '@dommaker/studio-shared';

describe('DiscordNotifier 凭证安全', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-notifier-'));
  const configPath = path.join(tmpDir, 'openclaw.json');
  fs.writeFileSync(configPath, JSON.stringify({ channels: { discord: { token: SECRET } } }));

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.DISCORD_CHANNEL_ID;
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('NODE_ENV=test 且未显式指定配置路径时不读用户真实配置', () => {
    // vitest 运行时 NODE_ENV=test；本机 ~/.openclaw/openclaw.json 可能存在（生产凭证），
    // 不指定 OPENCLAW_CONFIG_PATH 时 notifier 必须拿不到 token
    const notifier = new DiscordNotifier();
    expect((notifier as any).botToken).toBe('');
  });

  it('显式 OPENCLAW_CONFIG_PATH 时正常加载（测试本逻辑的唯一入口）', () => {
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    const notifier = new DiscordNotifier();
    expect((notifier as any).botToken).toBe(SECRET);
  });

  it('curl 兜底失败日志不含 token（execFile error.message 回显 argv 的防泄漏）', async () => {
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.DISCORD_CHANNEL_ID = 'chan-1';
    const notifier = new DiscordNotifier();
    // 代理指向关闭端口，curl 必失败
    (notifier as any).proxyUrl = 'http://127.0.0.1:9';

    await (notifier as any).sendViaCurl('chan-1', { content: 'hi' });

    const errorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls;
    expect(errorCalls.length).toBeGreaterThan(0);
    for (const call of errorCalls) {
      expect(JSON.stringify(call)).not.toContain(SECRET);
    }
    // 记的是 code/signal 而非 message
    const [, meta] = errorCalls[0];
    expect(meta).toHaveProperty('code');
    expect(meta).not.toHaveProperty('error');
  });
});
