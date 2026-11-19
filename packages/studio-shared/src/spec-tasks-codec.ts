/**
 * TASK 物化行 wire codec（#463；P2-c 自 apps/api modules/pmo/spec-materialization.ts 下沉）。
 *
 * `TASK: 标题 | AC: .. | BLOCKEDBY: .. | LEG: ..` 行格式是确认载荷生产方
 * （workunit/confirm-payload 序列化进 l3.summary）与消费方（pmo/spec-materialization
 * 物化、pmo/progress-rollup 完结判定、agents/completion-harvest 解析）的跨域共享契约——
 * 挂任一域模块都会拉成互耦边，正本放 shared 同源（同 channels-codec 先例）。
 * 人永远不接触魔法行：序列化/解析都走本正本，禁止手写复刻。
 */

/** 物化任务条数上限（照 MAP_OPENING_FOG_MAX 先例防刷屏） */
export const SPEC_TASKS_MAX = 12;

/** #701 plan 发布 scope 与 agent-loop 产出段共用的 TASK 协议正本。 */
export const PLAN_TASK_CONTRACT = [
  'TASK: <任务描述> | LEG: <gitRepo> | AC: <验收标准> | BLOCKEDBY: <wuId,...>',
  '每条 TASK 必须且只能归属一条 LEG、至少一条 AC；LEG 必须逐字取自交付腿仓库路径。多条 AC 追加「| AC: <下一条>」；无依赖时写 BLOCKEDBY: none，有依赖时填既有 WU id（逗号分隔）。腿归属未知、缺失、重复或有歧义时输出 ACTION: NEED_INPUT 请人澄清，不得默认选择第一仓。',
].join('\n');

/** 单行物化规格（TASK 行解析结果） */
export interface SpecTaskSpec {
  title: string;
  ac: string[];
  blockedBy: string[];
  /** 交付腿 gitRepo（未指定为 undefined；是否命中项目在物化时判定） */
  leg?: string;
}

/**
 * 从人工确认文本提取物化清单。逐行解析 `TASK:` 行，段内 `KEY: value`
 * 兼容中英文冒号；非约定行/非约定段原样忽略（确认文本可同时写其他结论）。
 */
export function parseSpecTasks(summary: string): SpecTaskSpec[] {
  const tasks: SpecTaskSpec[] = [];
  for (const line of summary.split('\n')) {
    const head = line.match(/^\s*TASK\s*[:：]\s*(.+?)\s*$/i);
    if (!head || tasks.length >= SPEC_TASKS_MAX) continue;
    const segments = head[1]!.split('|');
    const task: SpecTaskSpec = { title: segments[0]!.trim(), ac: [], blockedBy: [] };
    if (!task.title) continue;
    let legCount = 0;
    for (const seg of segments.slice(1)) {
      const m = seg.match(/^\s*(AC|BLOCKEDBY|LEG)\s*[:：]\s*(.+?)\s*$/i);
      if (!m) continue;
      const [, key, value] = m;
      if (!value) continue;
      switch (key.toUpperCase()) {
        case 'AC':
          task.ac.push(value);
          break;
        case 'BLOCKEDBY':
          if (value.trim().toLowerCase() !== 'none') {
            task.blockedBy.push(...value.split(/[,，]/).map(s => s.trim()).filter(Boolean));
          }
          break;
        case 'LEG':
          legCount += 1;
          // 重复 LEG 必须留下缺失归属供 plan 确认/派生 fail-closed，不能静默取首段。
          task.leg = legCount === 1 ? value : undefined;
          break;
      }
    }
    tasks.push(task);
  }
  return tasks;
}

/**
 * #463：SpecTaskSpec 清单 → TASK 物化行文本（parseSpecTasks 的逆运算，同一契约正本）。
 * 确认表单（review-passed confirm body）由后端序列化进 l3.summary——人永远不接触魔法行。
 * 空清单 → 空串（调用方据此不落 summary，哨兵不落档可补确认）。
 */
export function serializeSpecTasks(tasks: SpecTaskSpec[]): string {
  return tasks.map(task => {
    const segments = [`TASK: ${task.title}`];
    for (const ac of task.ac) segments.push(`AC: ${ac}`);
    if (task.blockedBy.length > 0) segments.push(`BLOCKEDBY: ${task.blockedBy.join(',')}`);
    if (task.leg) segments.push(`LEG: ${task.leg}`);
    return segments.join(' | ');
  }).join('\n');
}
