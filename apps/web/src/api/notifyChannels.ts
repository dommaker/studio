// 通知渠道 API — #525 P2-6：企业微信 webhook / ClawBot（个人微信）扫码绑定 / 测试消息。
// 服务端契约冻结（base /notify-channels），设置页「通知渠道」区唯一数据源。
import { api } from './index';

export interface WecomChannelState {
  configured: boolean;
  maskedUrl: string | null;
  source: 'settings' | 'env' | null;
}

export interface ClawbotChannelState {
  bound: boolean;
  ilinkUserId: string | null;
  boundAt: string | null;
}

export interface NotifyChannelsState {
  wecom: WecomChannelState;
  clawbot: ClawbotChannelState;
}

/** ClawBot 绑定轮询状态机：wait（未扫）→ scaned（已扫未确认）→ confirmed（绑定完成） */
export type ClawbotBindStatus = 'wait' | 'scaned' | 'confirmed';

export const notifyChannelsApi = {
  /** 读取两个渠道的当前状态 */
  getStatus: () => api.get<{ success: boolean; data: NotifyChannelsState }>('/notify-channels'),

  /** 保存企业微信 webhook URL（空串清除） */
  saveWecom: (webhookUrl: string) =>
    api.put<{ success: boolean; data: WecomChannelState }>('/notify-channels/wecom', { webhookUrl }),

  /** 发送企业微信测试消息（400 未配置 / 502 送达失败） */
  testWecom: () => api.post<{ success: boolean }>('/notify-channels/wecom/test'),

  /** 发起 ClawBot 扫码绑定，返回二维码内容（qrcodeUrl 为 liteapp 网页 URL，前端渲染成二维码图） */
  startClawbotBind: () =>
    api.post<{ success: boolean; data: { qrcode: string; qrcodeUrl: string } }>('/notify-channels/clawbot/bind/start'),

  /** 轮询绑定状态（按 qrcode 标识本次绑定会话） */
  getClawbotBindStatus: (qrcode: string) =>
    api.get<{ success: boolean; data: { status: ClawbotBindStatus; bound: boolean } }>(
      '/notify-channels/clawbot/bind/status',
      { params: { qrcode } },
    ),

  /** 解绑 ClawBot */
  unbindClawbot: () => api.post<{ success: boolean }>('/notify-channels/clawbot/unbind'),

  /** 发送 ClawBot 测试消息（400 未绑定 / 502 送达失败） */
  testClawbot: () => api.post<{ success: boolean }>('/notify-channels/clawbot/test'),
};
