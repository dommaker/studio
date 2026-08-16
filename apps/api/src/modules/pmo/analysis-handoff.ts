/**
 * Analysis Handoff — PMO 分析接力（分析结论 → 拆任务 → 派工）
 *
 * 订阅 workunit.status_changed，补上 PMO 链路的断环：
 *   1) analysis WU → in_review：ReviewDispatcher 对 analysis 不派自动评审
 *     （diff-only 契约对非代码产物恒 needs-info 转人工，纯噪声）——本服务在频道
 *      提示人工确认入口；确认动作 = WorkUnit 列表/抽屉的「通过」（reviewPassed）。
 *   2) analysis WU → done（人工确认通过）：按 metadata.analysisTasks
 *     （agent-loop 解析 TASK: 行落档）建未指派 task 子 WU —— 频道成员 loop
 *      observe 到未指派即认领，派工完成；频道发任务清单。
 *      metadata.analysisTasksSpawnedAt 为幂等哨兵，防重复派生。
 *   未输出 TASK: 行的分析：确认后只提示可手动拆任务，不自动派生。
 *
 * 事件订阅语义与 ReviewDispatcher 一致（eventBus 进程内，best-effort）。
 */

import { eventBus, logger, type FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, ANALYSIS_TASKS_MAX, type WorkUnitData, type WorkUnitMetadata } from '../workunit/workunit.service.js';
import { parseWuMetadata } from '../workunit/wu-metadata.js';
import { ChannelMessageService } from '../channels/channel-message.service.js';

export class AnalysisHandoff {
  private subscribed = false;
  private messageService: ChannelMessageService;

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

    eventBus.subscribe('workunit.status_changed', async (payload: { workunit: WorkUnitData }) => {
      const wu = payload.workunit;
      if (!wu || wu.type !== 'analysis') return;
      if (wu.status === 'in_review') {
        await this.postConfirmGuidance(wu).catch(err =>
          logger.warn('[AnalysisHandoff] postConfirmGuidance failed', { wuId: wu.id, error: String(err) }),
        );
      } else if (wu.status === 'done') {
        await this.spawnTasks(wu).catch(err =>
          logger.warn('[AnalysisHandoff] spawnTasks failed', { wuId: wu.id, error: String(err) }),
        );
      }
    });
  }

  private readMeta(wu: WorkUnitData): WorkUnitMetadata {
    return parseWuMetadata(wu.metadata);
  }

  private async post(wu: WorkUnitData, content: string): Promise<void> {
    if (!wu.channelId || !content.trim()) return;
    await this.messageService.createAgentMessage(wu.channelId, 'Studio', content, { workUnitId: wu.id });
  }

  /** in_review：提示人工确认入口（确认后自动拆任务派工） */
  private async postConfirmGuidance(wu: WorkUnitData): Promise<void> {
    const meta = this.readMeta(wu);
    // #163（T8-E2，#130 决策 2）：巡检单走机会清单确认（web 逐条采纳/忽略），
    // 不拆 TASK 派工；消息说人话（不出现机制黑话），指路报告与工单详情页。
    if (meta.inspection === true) {
      const pending = (Array.isArray(meta.opportunities) ? meta.opportunities : [])
        .filter(o => o && o.status === 'pending').length;
      await this.post(
        wu,
        pending > 0
          ? `巡检完成（#${wu.id.slice(0, 8)}）：发现 ${pending} 条改进机会，细节报告在业务仓 .studio/research/ 目录。请到工单详情页逐条决定「采纳」（自动开需求单进认领池）或「忽略」`
          : `巡检完成（#${wu.id.slice(0, 8)}）：本轮未发现改进机会，细节报告在业务仓 .studio/research/ 目录`,
      );
      return;
    }
    const hasTasks = Array.isArray(meta.analysisTasks);
    await this.post(
      wu,
      `分析结论已提交审查（#${wu.id.slice(0, 8)}）：请人工在 WorkUnit 列表/详情点「通过」确认结论`
      + (hasTasks ? '，确认后将按 TASK 拆分自动派工' : '（本次未输出 TASK 拆分行，确认后可手动转任务）')
      + '；结论有问题点「拒绝」，将由原 Agent 返工',
    );
  }

  /** done（人工确认）：按 analysisTasks 建未指派 task 子 WU（幂等） */
  private async spawnTasks(wu: WorkUnitData): Promise<void> {
    // 事件载荷可能是旧快照（重发/乱序）——幂等判定必须以库存最新状态为准
    const fresh = await this.workUnitService.getById(wu.id);
    if (!fresh) return;
    const meta = this.readMeta(fresh);
    // #163（T8-E2）：巡检单确认后不拆 TASK 派工——机会清单走 web 采纳/忽略消费
    if (meta.inspection === true) return;
    if (meta.analysisTasksSpawnedAt) return;

    const tasks = Array.isArray(meta.analysisTasks)
      ? meta.analysisTasks.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, ANALYSIS_TASKS_MAX)
      : [];

    // 幂等哨兵先落档：即便后续建单部分失败也不重复派生（失败只记日志，人工可补）。
    // 与 map-opening 同一 done 事件写同一 WU metadata（它落 mapOpenedAt）——
    // 写入前重读合并，防 read-modify-write 丢更新（#115 e2e 实测两哨兵互覆）
    const latest = await this.workUnitService.getById(fresh.id);
    const latestMeta = latest ? this.readMeta(latest) : meta;
    if (latestMeta.analysisTasksSpawnedAt) return; // 重读后哨兵已落（并发/重发）
    await this.workUnitService.update(fresh.id, {
      metadata: { ...latestMeta, analysisTasksSpawnedAt: new Date().toISOString() },
    });

    if (tasks.length === 0) {
      await this.post(fresh, '分析结论已确认。未输出 TASK 拆分行，不自动派生任务——可在频道里转任务或手动创建 WorkUnit');
      return;
    }

    const created: string[] = [];
    for (const scope of tasks) {
      try {
        await this.workUnitService.create({
          type: 'task',
          scope,
          status: 'unassigned',
          channelId: fresh.channelId,
          parentId: fresh.id,
          workspaceId: fresh.workspaceId ?? null,
          reqId: fresh.reqId ?? null,
          metadata: {
            creationMode: 'analysis-breakdown',
            // PMO 溯源（progress-rollup / delivery 台账消费）
            pmoId: meta.pmoId,
            pmoNumber: meta.pmoNumber,
            // B3a 归属链继承：analysis WU 的 workspaceRoot（publish 时由 project.gitRepo
            // 落档）传给 task 子 WU——agent-loop 据此走 per-WU worktree + PMO 分支合并，
            // 不继承则 task 直接在共享开发仓落地。
            ...(typeof meta.workspaceRoot === 'string' && meta.workspaceRoot.length > 0
              ? { workspaceRoot: meta.workspaceRoot }
              : {}),
          },
        });
        created.push(scope);
      } catch (err) {
        logger.warn('[AnalysisHandoff] create task WU failed (skip)', { wuId: fresh.id, scope: scope.slice(0, 80), error: String(err) });
      }
    }

    logger.info('[AnalysisHandoff] Spawned task WUs from analysis', { wuId: fresh.id, count: created.length });
    if (created.length > 0) {
      await this.post(
        fresh,
        `分析结论已确认，拆分 ${created.length} 个任务并派工（频道成员自动认领）：\n`
        + created.map((t, i) => `${i + 1}. ${t}`).join('\n'),
      );
    }
  }
}

// 单例（懒初始化，形态同 ReviewDispatcher）
let _analysisHandoff: AnalysisHandoff | null = null;

export function initAnalysisHandoff(fileStore?: FileStore): AnalysisHandoff {
  if (!_analysisHandoff) {
    const { FileStore } = require('@dommaker/studio-shared') as typeof import('@dommaker/studio-shared');
    const { WorkUnitService } = require('../workunit/workunit.service.js') as typeof import('../workunit/workunit.service.js');
    const fs = fileStore ?? new FileStore();
    _analysisHandoff = new AnalysisHandoff(fs, new WorkUnitService(fs));
  }
  _analysisHandoff.subscribeToEvents();
  return _analysisHandoff;
}
