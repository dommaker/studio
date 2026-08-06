// Notify API — 用户通知渠道配置（服务端持久化到 ~/.studio/notify-config.json；Settings 页「已同步/需重存」提示 + 保存）
import { api } from './index';

/** GET /notify/config/status 响应（每渠道一段：是否已有用户配置） */
export interface NotifyConfigStatus {
  discord: { hasUserConfig: boolean };
  wecom: { hasUserConfig: boolean };
  telegram: { hasUserConfig: boolean };
}

/** 用户 Webhook/Bot 配置（Settings 页表单形状，POST /notify/config 请求体） */
export interface NotifyUserConfig {
  discord?: { enabled: boolean; webhookUrl: string };
  wecom?: { enabled: boolean; webhookUrl: string };
  telegram?: { enabled: boolean; botToken: string; chatId: string };
}

export const notifyApi = {
  /** 各渠道用户配置状态（「已同步/需重存」指示的数据源） */
  getConfigStatus: () => api.get<NotifyConfigStatus>('/notify/config/status'),

  /** 保存用户通知渠道配置（服务端落盘持久化） → { success: true } */
  saveConfig: (config: NotifyUserConfig) =>
    api.post<{ success: boolean }>('/notify/config', config),
};
