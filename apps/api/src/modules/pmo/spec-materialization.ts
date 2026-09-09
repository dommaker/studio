/**
 * Spec Materialization — 交稿物化（#115 T9，#106 验收标准 4）
 *
 * 订阅 workunit.status_changed，把探路链路的最后一环接通：
 *   spec 成文单 → done（人工确认通过）且确认文本含 TASK 物化清单 →
 *   逐行解析批量建未指派 task 单（ac/blockedBy/腿归属齐全，频道成员 loop 认领）。
 *
 * 物化清单提取契约（机制只搬运人填文本，不做 LLM 提取；来源 = 人工确认台账
 * attestations.l3.summary，风格照 map-opening 的 DESTINATION:/FOG: 先例）：
 *   TASK: <标题> [| AC: <验收>]... [| BLOCKEDBY: <wuId,...>] [| LEG: <gitRepo>]
 *   逐段 `|` 分隔，段内 KEY: value（兼容中文冒号）：
 *     TASK      —— 标题（行首必填，空值忽略；清单上限 SPEC_TASKS_MAX 条）
 *     AC        —— 验收标准（可重复多段，逐段一条；落 metadata.ac[]，机制只存不解释）
 *     BLOCKEDBY —— 逗号分隔的 WU id（落 metadata.blockedBy[]，#109 接单过滤消费）
 *     LEG       —— 交付腿 gitRepo；命中项目交付腿 → metadata.workspaceRoot 落该仓库
 *                  （#113 腿归属判定 matchWuToLeg 消费）；不命中/缺省 → 不落（公共 WU，
 *                  保守计入每条腿台账）
 *   无 TASK 行 = 无物化清单 → 不建单、发频道提示可手动拆任务（形态照 analysis-handoff）。
 *
 * 幂等：metadata.specTasksSpawnedAt 哨兵（形态照 analysis-handoff）。#463 起改
 * 「无 TASK 行不落档」：确认时清单为空 = 人审有意不物化，不落哨兵——补确认
 * （F6-b l3 补写再发 status_changed）可再触发物化，消除旧「一键通过即永远烧掉」；
 * pmo/progress-rollup「派生未落定不翻 completed」判定（#115）同步按 l3.summary
 * 有无 TASK 行区分「未处理」与「有意不物化」。
 * 事件订阅语义与 DecisionResolution 一致（eventBus 进程内，best-effort）；
 * 同 PMO 的物化按 projectId 串行化（无 pmoId 按 WU id）。
 */

import { eventBus, logger, createSettledTracker, type FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitData, type WorkUnitMetadata } from '../workunit/workunit.service.js';
import { parseWuMetadata } from '../workunit/wu-metadata.js';
import { ChannelMessageService } from '../channels/channel-message.service.js';
import { projectService, resolveDeliveries, type ProjectData } from './project.service.js';

/** 物化任务条数上限（照 MAP_OPENING_FOG_MAX 先例防刷屏） */
export const SPEC_TASKS_MAX = 12;

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
          task.blockedBy.push(...value.split(/[,，]/).map(s => s.trim()).filter(Boolean));
          break;
        case 'LEG':
          if (task.leg === undefined) task.leg = value;
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

export class SpecMaterialization {
  private subscribed = false;
  private messageService: ChannelMessageService;
  /** #228 测试可观测性（纯增量，同 analysis-handoff）：在途事件链登记，见 waitForSettled */
  private readonly settled = createSettledTracker();

  constructor(
    private fileStore: FileStore,
    private workUnitService: WorkUnitService,
  ) {
    // 绑定同一 fileStore（测试注入临时 store；生产与全局同目录）
    this.messageService = new ChannelMessageService(fileStore);
  }

  /** 订阅 workunit.status_changed。幂等。 */
  subscribeToEvents(): void {
    if (this.subscribed) return;
    this.subscribed = true;

    eventBus.subscribe('workunit.status_changed', (payload: { workunit: WorkUnitData }) => {
      const wu = payload.workunit;
      if (!wu || wu.type !== 'spec' || wu.status !== 'done') return;
      this.settled.track(this.onSpecDone(wu.id).catch(err =>
        logger.warn('[SpecMaterialization] onSpecDone failed', { wuId: wu.id, error: String(err) }),
      ));
    });
  }

  /**
   * 等待本实例已触发的全部事件链落定（测试用确定性信号，替代盲等轮询；
   * 同 analysis-handoff.waitForSettled）。
   */
  async waitForSettled(): Promise<void> {
    await this.settled.waitForSettled();
  }

  private async onSpecDone(wuId: string): Promise<void> {
    // 事件载荷可能是旧快照（重发/乱序）——以库存最新状态为准（同 analysis-handoff）
    const fresh = await this.workUnitService.getById(wuId);
    if (!fresh) return;
    const meta = parseWuMetadata(fresh.metadata);
    // 幂等哨兵：已物化不重复建单
    if (meta.specTasksSpawnedAt) return;

    const pmoId = typeof meta.pmoId === 'string' ? meta.pmoId : '';
    await this.enqueue(pmoId || wuId, () => this.materialize(fresh, meta));
  }

  /** 同 PMO 的物化串行化（照 decision-resolution 链式排队，前序失败不阻断后续） */
  private chains = new Map<string, Promise<void>>();

  private enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const run = (this.chains.get(key) ?? Promise.resolve())
      .catch(() => { /* 前序失败不阻断后续 */ })
      .then(task);
    this.chains.set(key, run);
    const cleanup = () => { if (this.chains.get(key) === run) this.chains.delete(key); };
    run.then(cleanup, cleanup);
    return run;
  }

  private async materialize(wu: WorkUnitData, meta: WorkUnitMetadata): Promise<void> {
    const tasks = parseSpecTasks(meta.attestations?.l3?.summary ?? '');

    // #463：哨兵改「无 TASK 行不落档」——确认时清单为空 = 人审有意不物化（或旧一键通过
    // 误烧），不落 specTasksSpawnedAt，补确认（F6-b l3 补写会再发 status_changed）可再触发
    // 物化，消除一次性烧掉。rollup「物化未落定」判定同步按 l3.summary 有无 TASK 行区分
    // （progress-rollup 判③，无 TASK 行 = 已落定）。
    if (tasks.length === 0) {
      await this.postMaterialized(wu, []);
      logger.info('[SpecMaterialization] No TASK lines — nothing to materialize（哨兵不落档，可补确认）', { wuId: wu.id });
      return;
    }

    // 幂等哨兵先落档：即便后续建单部分失败也不重复派生（失败只记日志，人工可补）。
    await this.workUnitService.update(wu.id, {
      metadata: { ...meta, specTasksSpawnedAt: new Date().toISOString() },
    });

    // 腿归属判定输入：项目交付腿（无 pmoId/项目缺失 → LEG 段一律不命中，记日志）
    const pmoId = typeof meta.pmoId === 'string' ? meta.pmoId : '';
    const project: ProjectData | null = pmoId ? await projectService.get(pmoId).catch(() => null) : null;
    const legs = project ? resolveDeliveries(project) : [];

    const created: string[] = [];
    for (const spec of tasks) {
      try {
        let workspaceRoot: string | undefined;
        if (spec.leg) {
          const hit = legs.find(l => l.gitRepo === spec.leg);
          if (hit?.gitRepo) {
            workspaceRoot = hit.gitRepo;
          } else {
            logger.warn('[SpecMaterialization] LEG 未命中项目交付腿（按公共 WU 处理）', {
              wuId: wu.id, leg: spec.leg, pmoId,
            });
          }
        }
        await this.workUnitService.create({
          type: 'task',
          scope: spec.title,
          status: 'unassigned',
          channelId: wu.channelId,
          parentId: wu.id,
          metadata: {
            creationMode: 'spec-materialization',
            // PMO 溯源（progress-rollup / delivery 台账消费，同 analysis-handoff 先例）
            ...(pmoId ? { pmoId, pmoNumber: meta.pmoNumber } : {}),
            // 验收标准 / 接单依赖（#109：机制只存不解释 / blockedBy 未了结对所有 loop 不可见）
            ...(spec.ac.length > 0 ? { ac: spec.ac } : {}),
            ...(spec.blockedBy.length > 0 ? { blockedBy: spec.blockedBy } : {}),
            // 腿归属（#113：workspaceRoot 命中腿 gitRepo；agent-loop 同字段走 per-WU worktree）
            ...(workspaceRoot ? { workspaceRoot } : {}),
          },
        });
        created.push(spec.title);
      } catch (err) {
        logger.warn('[SpecMaterialization] create task WU failed (skip)', { wuId: wu.id, title: spec.title.slice(0, 80), error: String(err) });
      }
    }

    logger.info('[SpecMaterialization] Tasks materialized from spec', { wuId: wu.id, count: created.length });
    await this.postMaterialized(wu, created);
  }

  /** 频道发物化结果（best-effort）；空清单 = 提示可手动拆任务（形态照 analysis-handoff） */
  private async postMaterialized(wu: WorkUnitData, titles: string[]): Promise<void> {
    if (!wu.channelId) return;
    const content = titles.length === 0
      ? '成文单已确认。未输出 TASK 物化行，不自动派生任务——可在频道里转任务或手动创建 WorkUnit'
      : `成文单确认通过，物化 ${titles.length} 个任务单（频道成员自动认领；blockedBy 未了结的暂不可见）：\n`
        + titles.map((t, i) => `${i + 1}. ${t}`).join('\n');
    await this.messageService.createAgentMessage(
      wu.channelId,
      'Studio',
      content,
      { workUnitId: wu.id },
    ).catch(err =>
      logger.warn('[SpecMaterialization] postMaterialized failed (non-blocking)', { wuId: wu.id, error: String(err) }),
    );
  }
}

// 单例（懒初始化，形态同 DecisionResolution）
let _specMaterialization: SpecMaterialization | null = null;

export function initSpecMaterialization(fileStore?: FileStore): SpecMaterialization {
  if (!_specMaterialization) {
    const { FileStore } = require('@dommaker/studio-shared') as typeof import('@dommaker/studio-shared');
    const { WorkUnitService } = require('../workunit/workunit.service.js') as typeof import('../workunit/workunit.service.js');
    const fs = fileStore ?? new FileStore();
    _specMaterialization = new SpecMaterialization(fs, new WorkUnitService(fs));
  }
  _specMaterialization.subscribeToEvents();
  return _specMaterialization;
}
