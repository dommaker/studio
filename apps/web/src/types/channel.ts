// 频道域客户端本地类型（P3-a 自 api/channel.ts 迁出——api 层不声明导出类型，
// 契约类型正本在 @dommaker/studio-contract，本地扩展类型住 src/types/）。
import type { ChannelMessage as ContractChannelMessage } from '@dommaker/studio-contract';

/** 频道消息 = 契约 wire 形状 + 客户端本地标记（#326 骨架降级 / #486 乐观回显，服务端不下发） */
export interface ChannelMessage extends ContractChannelMessage {
  /** #326：骨架标记——数据层降级产物，content/meta 大头已剥离，结构字段仍在（ADR 2026-08-25） */
  degraded?: boolean;
  /** #486：乐观回显本地标记（仅客户端 pending 态；成功被本体替换、失败回滚） */
  pending?: boolean;
}
