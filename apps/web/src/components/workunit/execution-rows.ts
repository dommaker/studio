// 执行状态推导层（纯函数，组件/hook 只负责渲染与订阅）：
// - #240 工具行模型（参照 dsh toolRowModel 设计）。四态语义：
//   running — tool chunk 已见、result 未配对、步未结束
//   ok      — 配对 tool-result 且无 isError
//   error   — 配对 tool-result 且 isError
//   stopped — 步已结束（result chunk / REST 步卡片落位）仍未配对（中断合成，不永远转圈）
//   配对规则：toolUseId 精确匹配优先；result 缺 id 时位置兜底（最早未配对）；
//   孤儿 result（id 无匹配，如 tool chunk 被 50 条容量驱逐）跳过不产行。
//   Layer A 落盘步无逐工具结果：成功步全 ok；失败步全 stopped（执行中断于本步的诚实表达）。
// - #242 频道 live 状态条模型（deriveLiveExecutions）+ SSE data 防御解析（parseLiveStepRef/parseLiveWuRef）。
import type { ExecutionStepEvent, ExecutionStreamChunk } from '../../api/workunit';

export type ToolRowState = 'running' | 'ok' | 'error' | 'stopped';

export interface ToolRow {
  /** React key / 配对锚点：toolUseId 或位置序号 */
  key: string;
  tool: string;
  summary: string;
  state: ToolRowState;
  /** tool-result 文本（展开内容）；无 → undefined */
  output?: string;
}

/** Layer B 实时 chunk → 工具行（只消费 tool/tool-result，其余 chunk 由组件另行渲染） */
export function deriveLiveToolRows(chunks: ExecutionStreamChunk[], stepEnded: boolean): ToolRow[] {
  interface Acc { row: ToolRow; toolUseId?: string; paired: boolean }
  const acc: Acc[] = [];
  for (const c of chunks) {
    if (c.kind === 'tool' && c.tool) {
      acc.push({
        row: { key: c.toolUseId ?? `live-${acc.length}`, tool: c.tool, summary: c.summary ?? '', state: 'running' },
        toolUseId: c.toolUseId,
        paired: false,
      });
    } else if (c.kind === 'tool-result') {
      const target = (c.toolUseId && acc.find(a => a.paired === false && a.toolUseId === c.toolUseId))
        || (!c.toolUseId ? acc.find(a => !a.paired) : undefined);
      if (!target) continue; // 孤儿 result 跳过
      target.paired = true;
      target.row.state = c.isError ? 'error' : 'ok';
      if (c.text) target.row.output = c.text;
    }
  }
  return acc.map(a => ({
    ...a.row,
    state: a.paired ? a.row.state : (stepEnded ? 'stopped' : 'running'),
  }));
}

/** Layer A 落盘步 → 工具行（无逐工具结果可配对，按步状态合成） */
export function derivePersistedToolRows(step: ExecutionStepEvent): ToolRow[] {
  const state: ToolRowState = step.status === 'failed' ? 'stopped' : 'ok';
  return step.toolCalls.map((c, i) => ({
    key: `p-${step.step}-${i}`,
    tool: c.tool,
    summary: c.summary,
    state,
  }));
}

// ─── #242：频道 live 执行状态条 ───

/** 频道 live 状态条模型：本频道执行中 WU 的轻量展示态 */
export interface LiveExecution {
  workUnitId: string;
  /** 当前步号：SSE 步事件优先，缺省回退 metadata.stepCount；都未知 → undefined（只显示「正在执行」） */
  step?: number;
  action?: string;
}

/**
 * active WU 列表 + 最新步事件索引 → 状态条模型（顺序保持输入序）。
 * 步号口径：SSE workunit.execution.step 事件 > metadata.stepCount；stepCount=0/缺失 → 不显步号。
 */
export function deriveLiveExecutions(
  activeWus: ReadonlyArray<{ id: string; metadata?: string | null }>,
  latestStepByWu: Readonly<Record<string, { step: number; action?: string }>>,
): LiveExecution[] {
  return activeWus.map(wu => {
    const live = latestStepByWu[wu.id];
    if (live) {
      return { workUnitId: wu.id, step: live.step, ...(live.action ? { action: live.action } : {}) };
    }
    const step = readStepCount(wu.metadata);
    return { workUnitId: wu.id, ...(step !== undefined ? { step } : {}) };
  });
}

function readStepCount(metadata?: string | null): number | undefined {
  if (!metadata) return undefined;
  try {
    const m = JSON.parse(metadata) as { stepCount?: unknown };
    return typeof m.stepCount === 'number' && m.stepCount > 0 ? m.stepCount : undefined;
  } catch {
    return undefined;
  }
}

/** workunit.execution.step SSE data → 轻量引用（坏数据 → null，跳过不编造） */
export function parseLiveStepRef(data: unknown): { workUnitId: string; step: number; action?: string } | null {
  try {
    const p = (typeof data === 'string' ? JSON.parse(data) : data) as Record<string, unknown> | null;
    if (!p || typeof p !== 'object') return null;
    if (typeof p.workUnitId !== 'string' || typeof p.step !== 'number') return null;
    return {
      workUnitId: p.workUnitId,
      step: p.step,
      ...(typeof p.action === 'string' && p.action ? { action: p.action } : {}),
    };
  } catch {
    return null;
  }
}

/** workunit.status_changed SSE data（{ workunit } 信封）→ 轻量引用（坏数据/缺 id/status → null） */
export function parseLiveWuRef(
  data: unknown,
): { id: string; status: string; channelId: string | null; metadata: string | null } | null {
  try {
    const p = (typeof data === 'string' ? JSON.parse(data) : data) as Record<string, unknown> | null;
    const wu = p?.workunit as Record<string, unknown> | undefined;
    if (!wu || typeof wu.id !== 'string' || typeof wu.status !== 'string') return null;
    return {
      id: wu.id,
      status: wu.status,
      channelId: typeof wu.channelId === 'string' ? wu.channelId : null,
      metadata: typeof wu.metadata === 'string' ? wu.metadata : null,
    };
  } catch {
    return null;
  }
}
