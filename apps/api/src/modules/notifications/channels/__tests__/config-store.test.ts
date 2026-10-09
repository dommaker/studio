/**
 * #525 P2-6：notify-channels 配置存储测试
 *
 * 覆盖：
 * - 读写往返（wecom / clawbot 两段）
 * - 文件不存在 → 空配置；损坏 JSON / 形状不符 → 降级空配置（不炸）
 * - 清除（置 null 后写盘，读回为 null）
 * - resolveWeComWebhookUrl：配置存储优先，env WECOM_WEBHOOK_URL 兜底
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  notifyChannelsConfigPath,
  loadNotifyChannelsConfig,
  saveNotifyChannelsConfig,
  resolveWeComWebhookUrl,
} from '../config-store.js';

let tmpDir: string;
let envBackup: Record<string, string | undefined>;

const ENV_KEYS = ['STUDIO_HOME', 'WECOM_WEBHOOK_URL'] as const;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-channels-cfg-'));
  envBackup = {};
  for (const k of ENV_KEYS) envBackup[k] = process.env[k];
  process.env.STUDIO_HOME = tmpDir;
  delete process.env.WECOM_WEBHOOK_URL;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envBackup[k] === undefined) delete process.env[k];
    else process.env[k] = envBackup[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('notify-channels config-store (#525 P2-6)', () => {
  it('文件不存在 → 空配置', () => {
    expect(loadNotifyChannelsConfig()).toEqual({});
  });

  it('读写往返：wecom 与 clawbot 全字段保真', () => {
    saveNotifyChannelsConfig({
      wecom: { webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc123' },
      clawbot: {
        botToken: 'token-xyz',
        baseUrl: 'https://ilinkai.weixin.qq.com',
        ilinkBotId: 'bot-1',
        ilinkUserId: 'user-1',
        boundAt: '2026-09-12T00:00:00.000Z',
      },
    });

    const loaded = loadNotifyChannelsConfig();
    expect(loaded.wecom?.webhookUrl).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc123');
    expect(loaded.clawbot).toEqual({
      botToken: 'token-xyz',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      ilinkBotId: 'bot-1',
      ilinkUserId: 'user-1',
      boundAt: '2026-09-12T00:00:00.000Z',
    });
  });

  it('写前 mkdir -p：STUDIO_HOME 子目录不存在也能写', () => {
    const nested = path.join(tmpDir, 'a', 'b');
    process.env.STUDIO_HOME = nested;
    saveNotifyChannelsConfig({ wecom: { webhookUrl: 'https://qyapi.weixin.qq.com/x' } });
    expect(fs.existsSync(notifyChannelsConfigPath())).toBe(true);
    expect(loadNotifyChannelsConfig().wecom?.webhookUrl).toBe('https://qyapi.weixin.qq.com/x');
  });

  it('损坏 JSON → 记日志降级空配置，不抛错', () => {
    fs.writeFileSync(notifyChannelsConfigPath(), '{not json', 'utf-8');
    expect(loadNotifyChannelsConfig()).toEqual({});
  });

  it('形状不符（字段类型错）→ 降级剔除坏段，不抛错', () => {
    fs.writeFileSync(
      notifyChannelsConfigPath(),
      JSON.stringify({ wecom: { webhookUrl: 123 }, clawbot: 'oops' }),
      'utf-8',
    );
    const loaded = loadNotifyChannelsConfig();
    expect(loaded.wecom ?? null).toBeNull();
    expect(loaded.clawbot ?? null).toBeNull();
  });

  it('清除：wecom/clawbot 置 null 写盘后读回为 null', () => {
    saveNotifyChannelsConfig({
      wecom: { webhookUrl: 'https://qyapi.weixin.qq.com/x' },
      clawbot: {
        botToken: 't', baseUrl: 'https://ilinkai.weixin.qq.com',
        ilinkBotId: 'b', ilinkUserId: 'u', boundAt: '2026-09-12T00:00:00.000Z',
      },
    });
    saveNotifyChannelsConfig({ wecom: null, clawbot: null });
    const loaded = loadNotifyChannelsConfig();
    expect(loaded.wecom).toBeNull();
    expect(loaded.clawbot).toBeNull();
  });

  describe('resolveWeComWebhookUrl', () => {
    it('配置存储优先于 env（两个都设时取配置存储）', () => {
      process.env.WECOM_WEBHOOK_URL = 'https://qyapi.weixin.qq.com/env-hook';
      saveNotifyChannelsConfig({ wecom: { webhookUrl: 'https://qyapi.weixin.qq.com/settings-hook' } });

      expect(resolveWeComWebhookUrl()).toEqual({
        url: 'https://qyapi.weixin.qq.com/settings-hook',
        source: 'settings',
      });
    });

    it('仅 env 时取 env，source=env', () => {
      process.env.WECOM_WEBHOOK_URL = 'https://qyapi.weixin.qq.com/env-hook';
      expect(resolveWeComWebhookUrl()).toEqual({
        url: 'https://qyapi.weixin.qq.com/env-hook',
        source: 'env',
      });
    });

    it('都未配置 → url null / source null', () => {
      expect(resolveWeComWebhookUrl()).toEqual({ url: null, source: null });
    });
  });
});
