// PMO 页面共享领域类型 — KR / OKR / Project
// 契约驱动迁移（2026-10 批次 2/7）：手抄 interface 删除，统一 re-export 自
// @dommaker/studio-contract（原 Project 缺 companyId/okrId/gitRepo/deliveries 等
// 后端恒返回字段是漂移；OKR objectives/keyResults 可缺省同理）。
export type {
  Project,
  PmoMap,
  PmoDecision,
  FogItem,
  FogStatus,
  DeliveryLeg,
  DeliveryPolicy,
  Okr as OKR,
  OkrObjective as OKRObjective,
  OkrKeyResult as KR,
} from '@dommaker/studio-contract';
