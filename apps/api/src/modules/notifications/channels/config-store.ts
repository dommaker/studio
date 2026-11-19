/**
 * #525 P2-6：/settings「通知渠道」配置存储 —— ~/.studio 数据区配置文件读写
 *
 * 持久化 <STUDIO_HOME>/notify-channels.json（studioPath 拼接，禁止硬编码 home）。
 * 读写形态仿 projects/project-exclude-config：load 失败（不存在/非法 JSON/形状不符）
 * 记日志降级为空配置；写前 mkdir -p。
 *
 * env WECOM_WEBHOOK_URL 保留为部署级默认（resolveWeComWebhookUrl 中配置存储优先、env 兜底）。
 * 本文件是企微 webhook 与 ClawBot 凭据的唯一正本，alert-notifier（告警 fan-out）与
 * /api/v1/notify-channels 路由共用。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { logger } from '@dommaker/studio-shared/node';

/** ClawBot（iLink）绑定凭据：confirmed 轮询落盘，bot_token 长期有效（过期 errcode=-14 需重新扫码） */
export interface ClawBotConfig {
  botToken: string;
  baseUrl: string;
  ilinkBotId: string;
  ilinkUserId: string;
  /** ISO 时间戳（绑定确认时刻） */
  boundAt: string;
}

export interface NotifyChannelsConfig {
  wecom?: { webhookUrl: string } | null;
  clawbot?: ClawBotConfig | null;
}

export function notifyChannelsConfigPath(): string {
  return studioPath('notify-channels.json');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 形状校验：字段类型不符的段剔除（降级 null），不炸 */
function sanitize(parsed: unknown): NotifyChannelsConfig {
  if (!isRecord(parsed)) return {};
  const config: NotifyChannelsConfig = {};

  if (parsed.wecom === null) {
    config.wecom = null;
  } else if (isRecord(parsed.wecom) && typeof parsed.wecom.webhookUrl === 'string') {
    config.wecom = { webhookUrl: parsed.wecom.webhookUrl };
  }

  if (parsed.clawbot === null) {
    config.clawbot = null;
  } else if (isRecord(parsed.clawbot)) {
    const c = parsed.clawbot;
    if (
      typeof c.botToken === 'string' && typeof c.baseUrl === 'string'
      && typeof c.ilinkBotId === 'string' && typeof c.ilinkUserId === 'string'
      && typeof c.boundAt === 'string'
    ) {
      config.clawbot = {
        botToken: c.botToken,
        baseUrl: c.baseUrl,
        ilinkBotId: c.ilinkBotId,
        ilinkUserId: c.ilinkUserId,
        boundAt: c.boundAt,
      };
    }
  }

  return config;
}

function repairPermissions(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
}

/** 读配置：文件不存在/损坏/形状不符 → 记日志降级为空配置（通知渠道不受损，仅视为未配置） */
export function loadNotifyChannelsConfig(): NotifyChannelsConfig {
  try {
    const file = notifyChannelsConfigPath();
    repairPermissions(file);
    if (!fs.existsSync(file)) return {};
    return sanitize(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch (error) {
    logger.error('[NotifyChannels] Failed to load config (fallback to empty)', { error: String(error) });
    return {};
  }
}

/** 写配置（全量替换；写后 fchmod，避免依赖进程 umask）。 */
export function saveNotifyChannelsConfig(config: NotifyChannelsConfig): void {
  const file = notifyChannelsConfigPath();
  repairPermissions(file);
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(config, null, 2), 'utf-8');
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
}

export interface WeComWebhookResolution {
  url: string | null;
  /** settings = 配置存储；env = 仅环境变量（部署级默认） */
  source: 'settings' | 'env' | null;
}

/** 企微 webhook URL 解析：配置存储优先，env WECOM_WEBHOOK_URL 兜底 */
export function resolveWeComWebhookUrl(): WeComWebhookResolution {
  const stored = loadNotifyChannelsConfig().wecom?.webhookUrl?.trim();
  if (stored) return { url: stored, source: 'settings' };
  const env = process.env.WECOM_WEBHOOK_URL?.trim();
  if (env) return { url: env, source: 'env' };
  return { url: null, source: null };
}
