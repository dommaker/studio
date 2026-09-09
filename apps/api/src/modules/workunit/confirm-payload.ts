/**
 * #463：review-passed 结构化 confirm body 的校验与序列化（唯一正本）。
 *
 * 背景：确认闸（人工 review-passed）是 PMO 链派生的唯一扳机，但确认 UI 曾是一键通过、
 * 契约输入（TASK 物化行 / 决策结论 / 开图清单）全靠人手写魔法行——断链且不可补救。
 * 2026-09-09 决议（#463 评论）：确认 UI 改结构化评审表单，人点按钮，后端把表单数据
 * 序列化为 l3.summary——**存储格式不变**（下游解析契约 spec-materialization.parseSpecTasks /
 * map-opening.parseMapOpening / decision-resolution 原样消费），人永远不接触魔法行。
 *
 * body.confirm 三种形态（与裸 summary 并存时 confirm 优先；裸 summary 为兼容留路）：
 *   { kind: 'decision', conclusion }              → summary = 结论原文
 *   { kind: 'spec', tasks: SpecTaskInput[] }      → summary = TASK 物化行（serializeSpecTasks）
 *   { kind: 'analysis', destination?, fog[], tasks[] }
 *                                                 → summary = 目标：/待决：行；
 *                                                   tasks → analysisTasks（覆写 metadata.analysisTasks，
 *                                                   人审剔除/行内编辑生效，analysis-handoff 消费不变）
 * 校验失败抛 ConfirmPayloadError（路由转 400）；空结果（无结论/空清单）→ 对应字段缺省，
 * 语义 = 人审有意不带该输入（spec 空清单 = 不物化，哨兵不落档可补确认，见 spec-materialization）。
 */

import { ANALYSIS_TASKS_MAX } from './workunit.service.js';
import { MAP_OPENING_FOG_MAX } from '../pmo/map-opening.js';
import { SPEC_TASKS_MAX, serializeSpecTasks, type SpecTaskSpec } from '../pmo/spec-materialization.js';

export class ConfirmPayloadError extends Error {}

/** review-passed confirm body 的解析决议：summary 进 l3 台账；analysisTasks 覆写 metadata */
export interface ReviewConfirmResolution {
  summary?: string;
  analysisTasks?: string[];
}

function asString(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ConfirmPayloadError(`confirm.${field} 必须是字符串`);
  return v;
}

function asStringArray(v: unknown, field: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
    throw new ConfirmPayloadError(`confirm.${field} 必须是字符串数组`);
  }
  return v as string[];
}

/** spec 卡片墙输入（title 必填非空；ac/blockedBy/leg 可选）→ SpecTaskSpec */
function parseSpecTaskInput(raw: unknown, index: number): SpecTaskSpec | null {
  if (raw === null || typeof raw !== 'object') {
    throw new ConfirmPayloadError(`confirm.tasks[${index}] 必须是对象`);
  }
  const item = raw as Record<string, unknown>;
  const title = asString(item.title, `tasks[${index}].title`);
  if (title === undefined) throw new ConfirmPayloadError(`confirm.tasks[${index}].title 必填`);
  if (!title.trim()) return null; // 空标题行 = 人审留白的废行，过滤不报错
  const leg = asString(item.leg, `tasks[${index}].leg`)?.trim();
  return {
    title: title.trim(),
    ac: (asStringArray(item.ac, `tasks[${index}].ac`) ?? []).map(s => s.trim()).filter(Boolean),
    blockedBy: (asStringArray(item.blockedBy, `tasks[${index}].blockedBy`) ?? []).map(s => s.trim()).filter(Boolean),
    ...(leg ? { leg } : {}),
  };
}

/**
 * 解析 review-passed body.confirm。confirm 缺省/null → {}（裸 summary 路径不受影响）。
 */
export function resolveReviewConfirm(confirm: unknown): ReviewConfirmResolution {
  if (confirm === undefined || confirm === null) return {};
  if (typeof confirm !== 'object') throw new ConfirmPayloadError('confirm 必须是对象');
  const body = confirm as Record<string, unknown>;

  switch (body.kind) {
    case 'decision': {
      const conclusion = asString(body.conclusion, 'conclusion')?.trim();
      return conclusion ? { summary: conclusion } : {};
    }
    case 'spec': {
      if (body.tasks === undefined || body.tasks === null) return {};
      if (!Array.isArray(body.tasks)) throw new ConfirmPayloadError('confirm.tasks 必须是数组');
      const tasks = body.tasks
        .map((t, i) => parseSpecTaskInput(t, i))
        .filter((t): t is SpecTaskSpec => t !== null)
        .slice(0, SPEC_TASKS_MAX);
      const summary = serializeSpecTasks(tasks);
      return summary ? { summary } : {};
    }
    case 'analysis': {
      const destination = asString(body.destination, 'destination')?.trim();
      const fog = (asStringArray(body.fog, 'fog') ?? [])
        .map(s => s.trim()).filter(Boolean).slice(0, MAP_OPENING_FOG_MAX);
      const lines: string[] = [];
      if (destination) lines.push(`目标：${destination}`);
      for (const q of fog) lines.push(`待决：${q}`);
      const tasks = asStringArray(body.tasks, 'tasks')
        ?.map(s => s.trim()).filter(Boolean).slice(0, ANALYSIS_TASKS_MAX);
      return {
        ...(lines.length > 0 ? { summary: lines.join('\n') } : {}),
        // tasks 缺省 = 不覆写（兼容）；给出（含空数组 = 全剔除）= 覆写 metadata.analysisTasks
        ...(tasks !== undefined ? { analysisTasks: tasks } : {}),
      };
    }
    default:
      throw new ConfirmPayloadError(`confirm.kind 未知：${String(body.kind)}（支持 decision/spec/analysis）`);
  }
}
