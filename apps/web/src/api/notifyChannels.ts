// 通知渠道 API — #525 P2-6：企业微信 webhook / ClawBot（个人微信）扫码绑定 / 测试消息。
// 服务端契约冻结（base /notify-channels），设置页「通知渠道」区唯一数据源。
//
// 契约驱动迁移（2026-10 批次 5/7）：手抄 interface（WecomChannelState/
// ClawbotChannelState/NotifyChannelsState/ClawbotBindStatus）删除改 contract import；
// `{ success, data }` 壳的 success 标志退役（消费方 res.data.data 解包不变）；
// 错误 `{ success:false, error:string }` → `{ error: { code, message } }`
//（serverErrorMessage 读 error.message，两形态兼容）。
import type {
  WecomChannelState,
  ClawbotChannelState,
  NotifyChannelsState,
  ClawbotBindStatus,
  ClawbotBindStartResult,
  ClawbotBindStatusResult,
  NotifyChannelsSuccessResult,
} from '@dommaker/studio-contract';
import { api } from './index';

export type { WecomChannelState, ClawbotChannelState, NotifyChannelsState, ClawbotBindStatus };

export const notifyChannelsApi = {
  /** 读取两个渠道的当前状态 */
  getStatus: () => api.get<{ data: NotifyChannelsState }>('/notify-channels'),

  /** 保存企业微信 webhook URL（空串清除） */
  saveWecom: (webhookUrl: string) =>
    api.put<{ data: WecomChannelState }>('/notify-channels/wecom', { webhookUrl }),

  /** 发送企业微信测试消息（400 未配置 / 502 送达失败） */
  testWecom: () => api.post<{ data: NotifyChannelsSuccessResult }>('/notify-channels/wecom/test'),

  /** 发起 ClawBot 扫码绑定，返回二维码内容（qrcodeUrl 为 liteapp 网页 URL，前端渲染成二维码图） */
  startClawbotBind: () =>
    api.post<{ data: ClawbotBindStartResult }>('/notify-channels/clawbot/bind/start'),

  /** 轮询绑定状态（按 qrcode 标识本次绑定会话） */
  getClawbotBindStatus: (qrcode: string) =>
    api.get<{ data: ClawbotBindStatusResult }>(
      '/notify-channels/clawbot/bind/status',
      { params: { qrcode } },
    ),

  /** 解绑 ClawBot */
  unbindClawbot: () => api.post<{ data: NotifyChannelsSuccessResult }>('/notify-channels/clawbot/unbind'),

  /** 发送 ClawBot 测试消息（400 未绑定 / 502 送达失败） */
  testClawbot: () => api.post<{ data: NotifyChannelsSuccessResult }>('/notify-channels/clawbot/test'),
};
