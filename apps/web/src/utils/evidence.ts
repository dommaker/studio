// 证据三级白话标签全站正本（#385 词表：L1/L2/L3 内部编号不上界面）
// 原居 components/pmo/pipelineUtils（自称 PMO 域出口），#400 起消费方跨 pmo/workunit/utils 三域，上移至此；
// pipelineUtils 重出口保持既有 PMO 引用不动。
export const EVIDENCE_LAYER_LABELS = {
  l1: '自动验证',
  l2: 'Agent 评审',
  l3: '人工确认',
} as const;

export type EvidenceLayer = keyof typeof EVIDENCE_LAYER_LABELS;
