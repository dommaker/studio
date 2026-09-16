/**
 * Plan Direction — 方向锁定（#567）：plan 一脉会话裁决轮前置的一次性方向人闸。
 *
 * 方案正本 docs/plans/2026-09-plan-direction-picker.md：存在互斥大方向时 agent 先出一次
 * 方向卡（NEED_INPUT + DIRECTION: 行，契约见 prompt-composer PLAN_DIRECTION_SECTION；
 * 解析落 metadata.planDirections + waitingReason='plan-direction'，见 agent-loop），
 * 前端方向接力卡/弹窗让人单选一个方向（可附补充说明）。本模块是方向提交的唯一正本
 * （POST /workunits/:id/direction → applyPlanDirection），链路全仿 #467 plan-ruling：
 *
 *   1) 证据链落账（有 pmoId 时）：map.decisions[] 追加
 *      { wuId: planWuId, summary: `方向：<name>——<summary>（人锁定）`, resolvedAt }；
 *      方向抉择点命中 fog 条目 → 置 resolved（缺失不补建——方向题不一定来自 fog，
 *      与 ruling 的「缺失按 question 补建」不同）；map 未建则就地初始化
 *      （destination 回退项目标题，同 map-opening 缺省口径）。
 *      幂等：decisions[] 已有同 wuId+同结论条目 → 不双写。
 *   2) 同会话复活：composeDirectionReply（选定方向 + 是否推荐方向 + 补充说明）经
 *      resumeWaitingWorkUnit 注入 pendingReplies → active（sessionId 不动 = 同会话续跑，
 *      #94）；waitingReason/planDirections 随提交清除。频道自由文本回复仍是 fallback
 *      （waiting-input 通用路径）。
 *   3) 双出声：Web 按钮动作在频道不可见 → 复活后发 Studio 里程碑消息留痕
 *      （照 resumeBlockedWorkUnitFromWeb / applyPlanRuling 先例）。
 *
 * 无 pmoId 的 plan（非 PMO 链）只复活不写台账。map 写按 projectId 串行化
 * （照 plan-ruling / decision-resolution 链式排队）。
 */

import { logger, FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitData } from '../workunit/workunit.service.js';
import { parseWuMetadata } from '../workunit/wu-metadata.js';
import { resumeWaitingWorkUnit } from '../workunit/waiting-input.js';
import { postWuSystemMessage } from '../workunit/wu-messenger.js';
import { projectService, type PmoMap } from './project.service.js';
import { createKeyedEnqueue } from './keyed-enqueue.js';

/** 载荷校验失败（路由转 400） */
export class PlanDirectionError extends Error {}

/** 方向提交形态：选定的候选方向名 + 可选补充说明 */
export interface PlanDirectionPickInput {
  choice: string;
  note?: string;
}

/** 方向锁定的落档形态（与 workunit.types.ts WorkUnitMetadata.planDirections 同构） */
export interface PlanDirections {
  question: string;
  options: { name: string; summary: string; tradeoffs: string; impact: string; recommended: boolean }[];
}

const DIRECTION_FIELD_MAX_CHARS = 500;

/**
 * 校验方向提交载荷（路由层 400 契约）：raw 须为对象、choice 必填非空 string、
 * note 可选 string；choice 必须在 planDirections.options 的 name 集合内。
 */
export function validateDirectionPick(raw: unknown, planDirections: PlanDirections): PlanDirectionPickInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlanDirectionError('载荷必须是对象 {choice, note?}');
  }
  const body = raw as Record<string, unknown>;
  const choice = typeof body.choice === 'string' ? body.choice.trim() : '';
  if (!choice) throw new PlanDirectionError('choice 必填非空（选定的方向名）');
  const names = planDirections.options.map(o => o.name);
  if (!names.includes(choice)) {
    throw new PlanDirectionError(`choice「${choice}」不在候选方向内（可选：${names.join(' / ')}）`);
  }
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  return {
    choice: choice.slice(0, DIRECTION_FIELD_MAX_CHARS),
    ...(note ? { note: note.slice(0, DIRECTION_FIELD_MAX_CHARS) } : {}),
  };
}

/**
 * 应用方向选定：落账（有 pmoId 时）→ 清方向标记 → 组合选定文本复活同会话 → 频道里程碑。
 * @throws Error WU 不存在 / 非 blocked / 无待选 planDirections（路由按文案映射 404/409）
 */
export async function applyPlanDirection(
  workUnitId: string,
  pick: PlanDirectionPickInput,
  fs?: FileStore,
): Promise<WorkUnitData> {
  const fileStore = fs ?? new FileStore();
  const wuService = new WorkUnitService(fileStore);
  const wu = await wuService.getById(workUnitId);
  if (!wu) throw new Error(`WorkUnit ${workUnitId} not found`);
  if (wu.status !== 'blocked') {
    throw new Error(`WorkUnit 当前状态为 ${wu.status}，仅 blocked（方向锁定挂起）可提交方向选定`);
  }
  const meta = parseWuMetadata(wu.metadata);
  const planDirections = meta.planDirections as PlanDirections | undefined;
  if (!planDirections || !Array.isArray(planDirections.options) || planDirections.options.length === 0) {
    throw new Error(`WorkUnit ${workUnitId} 无待选的方向锁定（no pending direction）`);
  }
  const selected = planDirections.options.find(o => o.name === pick.choice)!; // 路由层已校验在集合内

  const pmoId = typeof meta.pmoId === 'string' ? meta.pmoId : '';
  if (pmoId) {
    await enqueue(pmoId, () => writeDirectionToMap(pmoId, workUnitId, planDirections, selected));
  }

  // 清方向标记（waitingReason/planDirections；waitingForInput 由复活原语清除）
  await fileStore.updateMetadata(workUnitId, latest => ({
    ...latest,
    waitingReason: undefined, // JSON 序列化丢弃 undefined → 清除
    planDirections: undefined,
  }));

  // 同会话复活：选定方向文本进 pendingReplies 注入下一步 prompt（sessionId 不动）
  const replyText = composeDirectionReply(pick, planDirections, selected);
  const resumed = await resumeWaitingWorkUnit(workUnitId, replyText, fileStore);
  if (!resumed) {
    // 竞态（状态在守卫检查后变化）：方向已落账，复活失败只记日志人工可补
    logger.warn('[PlanDirection] resume failed after direction applied (non-blocking)', { workUnitId });
  }

  if (wu.channelId) {
    const title = (meta.title ?? wu.scope).slice(0, 50);
    await postWuSystemMessage(
      wu,
      `任务「${title}」方向锁定已确认：选定「${selected.name}」，规划会话继续`,
      { milestone: true, fileStore },
    ).catch(err =>
      logger.warn('[PlanDirection] milestone notice failed (non-blocking)', { workUnitId, error: String(err) }),
    );
  }

  logger.info('[PlanDirection] Direction applied', { workUnitId, pmoId: pmoId || undefined, choice: selected.name });
  return (await wuService.getById(workUnitId))!;
}

/** 组合注入会话的方向选定文本（人的一次操作 → agent 下一步的直接上下文） */
function composeDirectionReply(
  pick: PlanDirectionPickInput,
  planDirections: PlanDirections,
  selected: PlanDirections['options'][number],
): string {
  const lines = ['[方向锁定结果] 人类已选定本票方向：'];
  lines.push(`- 抉择点「${planDirections.question}」→ 选定方向：「${selected.name}」——${selected.summary}`);
  lines.push(`- 该方向${selected.recommended ? '是' : '不是'} agent 推荐方向`);
  if (pick.note) lines.push(`- 补充说明：${pick.note}`);
  lines.push('方向结论已落探路台账，请按选定方向继续裁决轮 / spec 成文与 TASK 拆单。');
  return lines.join('\n');
}

/**
 * 落账：decisions[] 追加「方向：<name>——<summary>（人锁定）」结论；
 * 方向抉择点命中 fog 条目 → 置 resolved（缺失不补建——方向题不一定来自 fog）。
 * map 未建则就地初始化（destination 回退项目标题）。
 * 幂等：decisions[] 已有同 wuId+同结论条目 → 跳过不双写。
 */
async function writeDirectionToMap(
  projectId: string,
  wuId: string,
  planDirections: PlanDirections,
  selected: PlanDirections['options'][number],
): Promise<void> {
  const project = await projectService.get(projectId);
  if (!project) {
    logger.warn('[PlanDirection] project not found (skip map write)', { projectId, wuId });
    return;
  }
  const base: PmoMap = project.map ?? { destination: project.title, decisions: [], fog: [] };
  const fog = [...base.fog];
  const decisions = [...base.decisions];

  const summary = `方向：${selected.name}——${selected.summary}（人锁定）`;
  const dup = decisions.some(d => d.wuId === wuId && d.summary === summary);
  if (dup) return; // 幂等：重复提交不双写（fog  resolved 状态不变，无需落账）
  const idx = fog.findIndex(f => f.question === planDirections.question);
  if (idx >= 0) fog[idx] = { ...fog[idx], status: 'resolved' }; // 缺失不补建
  decisions.push({ wuId, summary, resolvedAt: new Date().toISOString() });

  await projectService.update(projectId, { map: { ...base, fog, decisions } });
}

/** 同 PMO 的 map 写串行化（共享实现 keyed-enqueue，前序失败不阻断后续） */
const enqueue = createKeyedEnqueue();
