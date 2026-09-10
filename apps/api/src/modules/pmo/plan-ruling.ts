/**
 * Plan Ruling — 裁决轮（#467）：plan 一脉会话内的一次性人闸。
 *
 * 票体「形态更新（2026-09-09 定稿）」：fog 调研齐后 agent 出一次裁决轮
 * （NEED_INPUT + RULING: 行，契约见 prompt-composer CONTRACT_TEMPLATES.plan；
 * 解析落 metadata.planRulings + waitingReason='plan-ruling'，见 agent-loop），
 * 前端裁决接力卡/弹窗让人一次操作：全对 / 单题修改 / 某题打回重议（只重调该题）。
 * 本模块是裁决提交的唯一正本（POST /workunits/:id/ruling → applyPlanRuling）：
 *
 *   1) 证据链批量落账：采纳题 → map.decisions[] 追加 { wuId: planWuId, summary: 结论,
 *      resolvedAt } + 对应 fog 置 resolved（条目缺失按 question 补建，wuId 恒 null——
 *      #471 起不再建 decision 单）；map 未建则就地初始化（destination 回退项目标题，
 *      同 map-opening 缺省口径）。打回重议题 → fog 保持/置 open。
 *      落账后 prompt-composer map 段（buildPmoMapSection）自然把已裁决结论注入后续
 *      prompt——裁决结果直接成为 spec 成文的上下文，零搬运损耗（#471 台账恢复面）。
 *      幂等：fog 已 resolved 且 decisions[] 已有同 wuId+同结论条目 → 不双写。
 *   2) 同会话复活：组合裁决结果文本（采纳/打回逐题列出）经 resumeWaitingWorkUnit
 *      注入 pendingReplies → active（sessionId 不动 = 同会话续跑，#94）；
 *      waitingReason/planRulings 随提交清除。频道自由文本回复仍是 fallback
 *      （waiting-input 通用路径）。
 *   3) 双出声：Web 按钮动作在频道不可见 → 复活后发 Studio 里程碑消息留痕
 *      （照 resumeBlockedWorkUnitFromWeb 先例）。
 *
 * 无 pmoId 的 plan（非 PMO 链）只复活不写台账。map 写按 projectId 串行化
 * （照 decision-resolution / map-opening 链式排队）。旧链 decision-resolution 不动
 * （只服务存量在飞 decision 单）。
 */

import { logger, FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitData } from '../workunit/workunit.service.js';
import { parseWuMetadata } from '../workunit/wu-metadata.js';
import { resumeWaitingWorkUnit } from '../workunit/waiting-input.js';
import { postWuSystemMessage } from '../workunit/wu-messenger.js';
import { projectService, type PmoMap } from './project.service.js';
import { MAP_OPENING_FOG_MAX } from './map-opening.js';
import { createKeyedEnqueue } from './keyed-enqueue.js';

/** 载荷校验失败（路由转 400） */
export class PlanRulingError extends Error {}

/** 裁决提交的单题形态：采纳（conclusion 必填非空）/ 打回重议（只重调该题） */
export interface PlanRulingItemInput {
  question: string;
  action: 'accept' | 'reopen';
  conclusion?: string;
}

const RULING_FIELD_MAX_CHARS = 500;

/**
 * 校验裁决提交载荷（路由层 400 契约）。items 1..MAP_OPENING_FOG_MAX 条；
 * question 必填非空；action ∈ accept/reopen；accept 必须有非空 conclusion。
 */
export function validateRulingItems(raw: unknown): PlanRulingItemInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new PlanRulingError('items 必须是非空数组');
  }
  if (raw.length > MAP_OPENING_FOG_MAX) {
    throw new PlanRulingError(`items 超过上限 ${MAP_OPENING_FOG_MAX} 条`);
  }
  return raw.map((entry, i) => {
    if (entry === null || typeof entry !== 'object') {
      throw new PlanRulingError(`items[${i}] 必须是对象`);
    }
    const item = entry as Record<string, unknown>;
    const question = typeof item.question === 'string' ? item.question.trim() : '';
    if (!question) throw new PlanRulingError(`items[${i}].question 必填非空`);
    if (item.action !== 'accept' && item.action !== 'reopen') {
      throw new PlanRulingError(`items[${i}].action 必须是 accept 或 reopen`);
    }
    if (item.action === 'accept') {
      const conclusion = typeof item.conclusion === 'string' ? item.conclusion.trim() : '';
      if (!conclusion) throw new PlanRulingError(`items[${i}] 采纳必须给结论（conclusion 非空）`);
      return {
        question: question.slice(0, RULING_FIELD_MAX_CHARS),
        action: 'accept' as const,
        conclusion: conclusion.slice(0, RULING_FIELD_MAX_CHARS),
      };
    }
    return { question: question.slice(0, RULING_FIELD_MAX_CHARS), action: 'reopen' as const };
  });
}

/**
 * 应用一次性裁决：批量落账（有 pmoId 时）→ 清裁决标记 → 组合结果文本复活同会话 → 频道里程碑。
 * @throws Error WU 不存在 / 非 blocked / 无待裁 rulings（路由按文案映射 404/409）
 */
export async function applyPlanRuling(
  workUnitId: string,
  items: PlanRulingItemInput[],
  fs?: FileStore,
): Promise<WorkUnitData> {
  const fileStore = fs ?? new FileStore();
  const wuService = new WorkUnitService(fileStore);
  const wu = await wuService.getById(workUnitId);
  if (!wu) throw new Error(`WorkUnit ${workUnitId} not found`);
  if (wu.status !== 'blocked') {
    throw new Error(`WorkUnit 当前状态为 ${wu.status}，仅 blocked（裁决轮挂起）可提交裁决`);
  }
  const meta = parseWuMetadata(wu.metadata);
  if (!Array.isArray(meta.planRulings) || meta.planRulings.length === 0) {
    throw new Error(`WorkUnit ${workUnitId} 无待裁的裁决轮（no pending ruling）`);
  }

  const pmoId = typeof meta.pmoId === 'string' ? meta.pmoId : '';
  if (pmoId) {
    await enqueue(pmoId, () => writeRulingsToMap(pmoId, workUnitId, items));
  }

  // 清裁决标记（waitingReason/planRulings；waitingForInput 由复活原语清除）
  await fileStore.updateMetadata(workUnitId, latest => ({
    ...latest,
    waitingReason: undefined, // JSON 序列化丢弃 undefined → 清除
    planRulings: undefined,
  }));

  // 同会话复活：裁决结果文本进 pendingReplies 注入下一步 prompt（sessionId 不动）
  const replyText = composeRulingReply(items);
  const resumed = await resumeWaitingWorkUnit(workUnitId, replyText, fileStore);
  if (!resumed) {
    // 竞态（状态在守卫检查后变化）：裁决已落账，复活失败只记日志人工可补
    logger.warn('[PlanRuling] resume failed after ruling applied (non-blocking)', { workUnitId });
  }

  const accepted = items.filter(i => i.action === 'accept').length;
  const reopened = items.length - accepted;
  if (wu.channelId) {
    const title = (meta.title ?? wu.scope).slice(0, 50);
    await postWuSystemMessage(
      wu,
      `任务「${title}」裁决轮已确认：采纳 ${accepted} 题${reopened > 0 ? `，打回重议 ${reopened} 题` : ''}，规划会话继续`,
      { milestone: true, fileStore },
    ).catch(err =>
      logger.warn('[PlanRuling] milestone notice failed (non-blocking)', { workUnitId, error: String(err) }),
    );
  }

  logger.info('[PlanRuling] Ruling applied', { workUnitId, pmoId: pmoId || undefined, accepted, reopened });
  return (await wuService.getById(workUnitId))!;
}

/** 组合注入会话的裁决结果文本（人的一次操作 → agent 下一步的直接上下文） */
function composeRulingReply(items: PlanRulingItemInput[]): string {
  const lines = ['[裁决轮结果] 人类已一次性裁决：'];
  for (const item of items) {
    if (item.action === 'accept') {
      lines.push(`- 采纳「${item.question}」：${item.conclusion}`);
    } else {
      lines.push(`- 打回重议「${item.question}」：保持待决，请只重调该题（补充调研后重新出裁决轮）`);
    }
  }
  const reopened = items.some(i => i.action === 'reopen');
  lines.push(reopened
    ? '采纳结论已落探路台账；重调齐后请再次出裁决轮。'
    : '全部待决问题已裁决并落探路台账，请继续 spec 成文（落业务仓 .studio/specs/）与 TASK 拆单。');
  return lines.join('\n');
}

/**
 * 批量落账：采纳题 decisions[] 追加 + fog 置 resolved（缺失按 question 补建）；
 * 打回题 fog 保持/置 open。map 未建则就地初始化（destination 回退项目标题）。
 * 幂等：fog 已 resolved 且 decisions[] 已有同 wuId+同结论条目 → 跳过不双写。
 */
async function writeRulingsToMap(
  projectId: string,
  wuId: string,
  items: PlanRulingItemInput[],
): Promise<void> {
  const project = await projectService.get(projectId);
  if (!project) {
    logger.warn('[PlanRuling] project not found (skip map write)', { projectId, wuId });
    return;
  }
  const now = new Date().toISOString();
  const base: PmoMap = project.map ?? { destination: project.title, decisions: [], fog: [] };
  const fog = [...base.fog];
  const decisions = [...base.decisions];
  let nextFogSeq = fog.length + 1;

  for (const item of items) {
    const idx = fog.findIndex(f => f.question === item.question);
    if (item.action === 'accept') {
      const dup = idx >= 0
        && fog[idx].status === 'resolved'
        && decisions.some(d => d.wuId === wuId && d.summary === item.conclusion);
      if (dup) continue; // 幂等：重复提交不双写
      if (idx >= 0) fog[idx] = { ...fog[idx], status: 'resolved' };
      else fog.push({ id: `fog-${nextFogSeq++}`, question: item.question, wuId: null, status: 'resolved' });
      decisions.push({ wuId, summary: item.conclusion!, resolvedAt: now });
    } else {
      if (idx >= 0) {
        if (fog[idx].status !== 'open') fog[idx] = { ...fog[idx], status: 'open' };
      } else {
        fog.push({ id: `fog-${nextFogSeq++}`, question: item.question, wuId: null, status: 'open' });
      }
    }
  }

  await projectService.update(projectId, { map: { ...base, fog, decisions } });
}

/** 同 PMO 的 map 写串行化（共享实现 keyed-enqueue，前序失败不阻断后续） */
const enqueue = createKeyedEnqueue();
