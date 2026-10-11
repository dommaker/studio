// okrMetric - OKR/KR 度量纯函数与常量（零依赖，自 PMOPage 抽出，工单 33）

// 🆕 AS-016: 获取当前季度
export function getCurrentQuarter(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const quarter = Math.floor(month / 3) + 1;
  return `${year}-Q${quarter}`;
}

/** 容错解析 id 数组 JSON（历史数据可能双重编码）；非数组/损坏 → [] */
export function parseIdArray(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    let v: unknown = JSON.parse(raw);
    if (typeof v === 'string') v = JSON.parse(v);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  } catch {
    return [];
  }
}

export interface KR {
  id: string;
  objectiveId: string;
  title: string;
  target: number;
  current: number;
  unit: string;
  metricType?: string;
}

export const METRIC_TYPE_OPTIONS = [
  { value: '', label: '手动更新' },
  { value: 'pipeline_duration_p90', label: '管线耗时 (p90)' },
  { value: 'pipeline_duration_per_phase', label: '单阶段耗时' },
  { value: 'cache_hit_rate', label: '缓存命中率' },
  { value: 'execution_success_rate', label: '执行成功率' },
  { value: 'review_pass_rate', label: '审查通过率' },
  { value: 'token_saving_ratio', label: 'Token 节省率' },
];

// B8 Phase 1.5: metricType 元数据
export const METRIC_META: Record<string, { unit: string; upperBound: number; baseline?: number }> = {
  '': { unit: '', upperBound: 100 },
  pipeline_duration_p90: { unit: 'min', upperBound: Infinity, baseline: 23 },
  pipeline_duration_per_phase: { unit: 'min', upperBound: Infinity },
  cache_hit_rate: { unit: '%', upperBound: 99.9, baseline: 94 },
  execution_success_rate: { unit: '%', upperBound: 100, baseline: 12 },
  review_pass_rate: { unit: '%', upperBound: 100 },
  token_saving_ratio: { unit: '%', upperBound: 90 },
};

interface KRValidation {
  status: 'pass' | 'warning' | 'blocked';
  reason: string;
}

export function validateKRTarget(kr: KR): KRValidation {
  if (kr.target <= 0) return { status: 'blocked', reason: '目标必须大于 0' };
  if (!kr.metricType) return { status: 'pass', reason: '' };

  const meta = METRIC_META[kr.metricType];
  if (!meta) return { status: 'pass', reason: '' };

  // Baseline check: target below current level
  if (meta.baseline !== undefined && kr.target < meta.baseline) {
    return {
      status: 'blocked',
      reason: `目标 (${kr.target}${meta.unit}) 低于当前水平 (${meta.baseline}${meta.unit})。建议 >= ${Math.ceil(meta.baseline * 1.05)}${meta.unit}`,
    };
  }

  // Upper bound check: target too close to theoretical limit
  if (meta.upperBound !== Infinity && kr.target > meta.upperBound * 0.95) {
    return {
      status: 'warning',
      reason: `接近理论上限 (${meta.upperBound}${meta.unit})，可能不可实现`,
    };
  }

  // Gap check: target too far from baseline
  if (meta.baseline !== undefined && kr.target > meta.baseline * 3) {
    return {
      status: 'warning',
      reason: `距当前水平 (${meta.baseline}${meta.unit}) 差距大，建议分阶段`,
    };
  }

  return { status: 'pass', reason: '' };
}
