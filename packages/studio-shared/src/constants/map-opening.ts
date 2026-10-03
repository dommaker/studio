/**
 * MAP 开篇（map-opening）台账线格式常量（P2-c 自 apps/api modules/pmo/map-opening.ts 下沉）。
 *
 * FOG 待决问题条数上限：生产方（workunit/confirm-payload 序列化「待决：」行、
 * agents/agent-loop-parsers 探路裁决解析）与消费方（pmo/map-opening 台账、pmo/plan-ruling）
 * 跨三个域模块共用——挂任一域模块都会拉成互耦边，放 shared 同源防漂移（同 monitoring.ts 先例）。
 */

/** FOG 待决问题条数上限（确认载荷序列化 / 台账展示 / 裁决提交校验同一上限） */
export const MAP_OPENING_FOG_MAX = 12;
