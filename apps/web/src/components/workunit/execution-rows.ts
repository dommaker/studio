// 工具行模型推导（#240，参照 dsh toolRowModel 设计）：纯函数，组件只负责渲染。
// 四态语义：
//   running — tool chunk 已见、result 未配对、步未结束
//   ok      — 配对 tool-result 且无 isError
//   error   — 配对 tool-result 且 isError
//   stopped — 步已结束（result chunk / REST 步卡片落位）仍未配对（中断合成，不永远转圈）
// 配对规则：toolUseId 精确匹配优先；result 缺 id 时位置兜底（最早未配对）；
// 孤儿 result（id 无匹配，如 tool chunk 被 50 条容量驱逐）跳过不产行。
// Layer A 落盘步无逐工具结果：成功步全 ok；失败步全 stopped（执行中断于本步的诚实表达）。
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
