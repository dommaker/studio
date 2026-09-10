// PMO 地图区 — 纯函数（#114 T8，#106 子票）
// 待决问题徽章口径 / 「下一个该干什么」排序细则 / 任务单依赖图拼装。
// 组件见 ProjectMap.tsx；页面数据流见 ProjectDetailPage。
// UI 文案不用行话（#53/#74 偏好）：fog=待决问题、blockedBy=依赖、decision=决策单。

/** 待决问题状态（后端 FogStatus，机制只写 open / resolved；in-discussion 预留） */
export type FogStatus = 'open' | 'in-discussion' | 'resolved';

/** 待决问题条目；wuId = 认领该问题的决策单，未建单为 null */
export interface FogItem {
  id: string;
  question: string;
  wuId: string | null;
  status: FogStatus;
}

/** 结论时间线条目（决策单人工确认时填写的一句话结论，机制原样存） */
export interface PmoDecision {
  wuId: string;
  summary: string;
  resolvedAt: string;
}

/** 探路地图（project.map；缺省 null = 非探路型需求，页面不渲染地图区） */
export interface PmoMap {
  destination: string;
  decisions: PmoDecision[];
  fog: FogItem[];
}

/** 待决问题徽章四态 */
export type FogBadge = 'claimable' | 'discussing' | 'confirming' | 'resolved';

export const FOG_BADGE_META: Record<FogBadge, { label: string; className: string }> = {
  claimable: { label: '待认领', className: 'u-surface-2 u-text-2' },
  discussing: { label: '讨论中', className: 'u-accent-dim u-accent' },
  confirming: { label: '待确认', className: 'u-warn-dim u-warn' },
  resolved: { label: '已定', className: 'u-ok-dim u-ok' },
};

/**
 * 待决问题徽章口径（以实际数据为准，与 apps/web/src/CONTEXT.md 同步）：
 *   已定   = fog 已 resolved（决策单确认落地、结论进了时间线）
 *   待确认 = 决策单在审（WU in_review），结论已提待人工拍板
 *   讨论中 = fog in-discussion，或决策单已被认领在执行（active / waitingForInput）
 *   待认领 = 其余：未建决策单（wuId = null），或单已建但还无人认领（unassigned）
 */
export function resolveFogBadge(fog: Pick<FogItem, 'status' | 'wuId'>, wuStatus?: string | null): FogBadge {
  if (fog.status === 'resolved') return 'resolved';
  if (wuStatus === 'in_review') return 'confirming';
  if (fog.status === 'in-discussion' || wuStatus === 'active' || wuStatus === 'waitingForInput') return 'discussing';
  return 'claimable';
}

/** 「下一个该干什么」候选单（列表 API claimable=true 过滤后的最小形状） */
export interface NextActionCandidate {
  id: string;
  title: string;
  type?: string;
  createdAt?: string | null;
  /** 决策单 metadata.fogId（决定它在地图里的顺序） */
  fogId?: string | null;
}

/**
 * 「下一个该干什么」排序细则（#114；改动须同步 apps/web/src/CONTEXT.md）：
 *   候选 = 本项目可认领的单（列表 API claimable=true：未指派且依赖已清）；
 *   ① 决策单（type=decision）优先，按地图待决问题顺序（fogId 不在图中排末尾，按创建时间兜底）；
 *   ② 其余单按创建时间升序（早建先干）。
 */
export function pickNextAction(
  candidates: NextActionCandidate[],
  fogOrder: string[],
): NextActionCandidate | null {
  if (candidates.length === 0) return null;
  const time = (c: NextActionCandidate) => Date.parse(c.createdAt ?? '') || 0;
  const fogIdx = (c: NextActionCandidate) => {
    const i = c.fogId ? fogOrder.indexOf(c.fogId) : -1;
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const decisions = candidates
    .filter(c => c.type === 'decision')
    .sort((a, b) => fogIdx(a) - fogIdx(b) || time(a) - time(b));
  if (decisions.length > 0) return decisions[0];
  return [...candidates].sort((a, b) => time(a) - time(b))[0];
}

/** 容错解析 metadata.blockedBy（字符串 metadata；缺失/坏 JSON/非数组 → []） */
export function parseBlockedBy(metadata?: string | null): string[] {  if (!metadata) return [];
  try {
    const v = (JSON.parse(metadata) as { blockedBy?: unknown }).blockedBy;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  } catch {
    return [];
  }
}

/**
 * #463：确认弹窗结构化预填（resolution 评论：结构化数据在确认之前已落档，
 * 人审表单不做录入只做判断；后端把表单序列化进 l3.summary，存储契约不变）。
 * 三个构建器分别对应 analysis / spec / decision 确认弹窗；metadata 坏 JSON / 字段畸形
 * 一律兜底空结构（弹窗空手评，不炸）。
 */

/** analysis 确认表单预填：destination（目标）+ fog（待决清单）+ tasks（TASK 拆分预览） */
export interface AnalysisConfirmPrefill {
  destination: string;
  fog: string[];
  tasks: string[];
}

/** 吸收 #106 M7 buildMapOpeningPrefill：同一数据源，结构化输出替代魔法行文本 */
export function buildAnalysisConfirmPrefill(metadata?: string | null): AnalysisConfirmPrefill {
  const empty: AnalysisConfirmPrefill = { destination: '', fog: [], tasks: [] };
  if (!metadata) return empty;
  try {
    const v = JSON.parse(metadata) as {
      analysisDestination?: unknown;
      analysisFog?: unknown;
      analysisTasks?: unknown;
    };
    const strings = (x: unknown): string[] =>
      Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map(s => s.trim()) : [];
    return {
      destination: typeof v.analysisDestination === 'string' ? v.analysisDestination.trim() : '',
      fog: strings(v.analysisFog),
      tasks: strings(v.analysisTasks),
    };
  } catch {
    return empty;
  }
}

/** spec 确认表单卡片墙条目（blockedBy/leg 人审不编辑但须透传给后端序列化） */
export interface SpecTaskFormItem {
  title: string;
  ac: string[];
  blockedBy: string[];
  leg?: string;
}

/** spec 卡片墙预填（metadata.specTasks，agent COMPLETE 时 agent-loop 落档） */
export function buildSpecConfirmPrefill(metadata?: string | null): SpecTaskFormItem[] {
  if (!metadata) return [];
  try {
    const v = (JSON.parse(metadata) as { specTasks?: unknown }).specTasks;
    if (!Array.isArray(v)) return [];
    return v
      .filter((t): t is Record<string, unknown> => t !== null && typeof t === 'object')
      .filter(t => typeof t.title === 'string' && t.title.trim().length > 0)
      .map(t => ({
        title: (t.title as string).trim(),
        ac: Array.isArray(t.ac) ? t.ac.filter((s): s is string => typeof s === 'string') : [],
        blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy.filter((s): s is string => typeof s === 'string') : [],
        ...(typeof t.leg === 'string' && t.leg ? { leg: t.leg } : {}),
      }));
  } catch {
    return [];
  }
}

/** decision 确认表单预填（metadata.decisionSuggestion，agent `## 结论摘要` 段落档） */
export function buildDecisionConfirmPrefill(metadata?: string | null): string {
  if (!metadata) return '';
  try {
    const v = (JSON.parse(metadata) as { decisionSuggestion?: unknown }).decisionSuggestion;
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

/**
 * 列表 API 的 WU 行 → 「下一个该干什么」候选。
 * 门槛：claimable=true（未指派且依赖已清）且 metadata.pmoId 属于本 PMO；
 * 标题取 metadata.title，缺省回退 scope 首行截断。metadata 坏 JSON / 不属本 PMO → null。
 */
export function toNextActionCandidate(
  wu: {
    id: string;
    type?: string;
    scope?: string;
    createdAt?: string | null;
    metadata?: string | null;
    claimable?: boolean;
  },
  projectId: string,
): NextActionCandidate | null {
  if (wu.claimable !== true) return null;
  let meta: { pmoId?: unknown; title?: unknown; fogId?: unknown } | null = null;
  try {
    meta = wu.metadata ? JSON.parse(wu.metadata) : null;
  } catch {
    meta = null;
  }
  if (!meta || meta.pmoId !== projectId) return null;
  const fallbackTitle = (wu.scope ?? '').split('\n')[0].trim();
  return {
    id: wu.id,
    title: typeof meta.title === 'string' && meta.title ? meta.title : (fallbackTitle || wu.id).slice(0, 60),
    type: wu.type,
    createdAt: wu.createdAt ?? null,
    fogId: typeof meta.fogId === 'string' ? meta.fogId : null,
  };
}

/** 依赖图行：一个任务单 + 它等的前置单清单 */
export interface TaskDepRow {  id: string;
  title: string;
  status: string;
  deps: Array<{
    id: string;
    /** 前置单在本批 WU 里找得到 → 标题/状态；找不到（跨 PMO 或已删）→ null，防御展示 */
    title: string | null;
    status: string | null;
  }>;
}

/**
 * 任务单依赖图拼装：只收有依赖的单（blockedBy 非空），按输入顺序（chain 已按创建时间升序）。
 */
export function buildTaskDepRows(
  wus: Array<{ id: string; title: string; status: string; metadata?: string | null }>,
): TaskDepRow[] {
  const byId = new Map(wus.map(w => [w.id, w]));
  const rows: TaskDepRow[] = [];
  for (const wu of wus) {
    const blockedBy = parseBlockedBy(wu.metadata);
    if (blockedBy.length === 0) continue;
    rows.push({
      id: wu.id,
      title: wu.title,
      status: wu.status,
      deps: blockedBy.map(depId => {
        const dep = byId.get(depId);
        return { id: depId, title: dep?.title ?? null, status: dep?.status ?? null };
      }),
    });
  }
  return rows;
}

/** 依赖图状态标签（大白话，不用行话；未知状态原样显示） */
export const DEP_STATUS_LABEL: Record<string, string> = {
  pending: '待确认',
  unassigned: '待认领',
  active: '进行中',
  waitingForInput: '等回复',
  in_review: '待确认',
  blocked: '阻塞',
  done: '已完成',
  closed: '已关闭',
  failed: '失败',
  completed: '已完成',
};
