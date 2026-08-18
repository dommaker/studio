/**
 * Analysis Handoff — PMO 分析接力（分析结论 → 拆任务 → 派工）
 *
 * 订阅 workunit.status_changed，补上 PMO 链路的断环：
 *   1) analysis WU → in_review：ReviewDispatcher 对 analysis 不派自动评审
 *     （diff-only 契约对非代码产物恒 needs-info 转人工，纯噪声）——本服务在频道
 *      提示人工确认入口；确认动作 = WorkUnit 列表/抽屉的「通过」（reviewPassed）。
 *      #186（#167 决议）起按来源分流：无频道 + trigger 来源 + 无 TASK 的巡检单
 *      免确认直转 done；无频道其余情形保留人闸、确认提示改投 Web「需要处理」
 *      收件箱（monitor:alert，修 channelId=null 早退吞提示的断链）。
 *   2) analysis WU → done（人工确认通过）：按 metadata.analysisTasks
 *     （agent-loop 解析 TASK: 行落档）建未指派 task 子 WU —— 频道成员 loop
 *      observe 到未指派即认领，派工完成；频道发任务清单。
 *      metadata.analysisTasksSpawnedAt + analysisTasksSpawned（已建子 WU id 清单，
 *      #183 起清单化）为幂等哨兵，防重复派生；断链由 5min 对账扫描补差集自愈
 *      （agents/dispatch-reconciliation.ts，#159 决议）。
 *   未输出 TASK: 行的分析：确认后只提示可手动拆任务，不自动派生。
 *
 * 事件订阅语义与 ReviewDispatcher 一致（eventBus 进程内，best-effort）。
 */

import { eventBus, logger, createSettledTracker, type FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, ANALYSIS_TASKS_MAX, type WorkUnitData, type WorkUnitMetadata } from '../workunit/workunit.service.js';
import { parseWuMetadata } from '../workunit/wu-metadata.js';
import { ChannelMessageService } from '../channels/channel-message.service.js';
import { dispatchMonitorAlerts } from '../agents/monitor/monitor-alerts.js';

export class AnalysisHandoff {
  private subscribed = false;
  private messageService: ChannelMessageService;
  /** #228 测试可观测性（纯增量）：在途事件链登记，见 waitForSettled */
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
      this.settled.track(this.handleStatusChanged(payload.workunit));
    });
  }

  private async handleStatusChanged(wu: WorkUnitData): Promise<void> {
    if (!wu || wu.type !== 'analysis') return;
    if (wu.status === 'in_review') {
      await this.handleInReview(wu).catch(err =>
        logger.warn('[AnalysisHandoff] handleInReview failed', { wuId: wu.id, error: String(err) }),
      );
    } else if (wu.status === 'done') {
      await this.spawnTasks(wu).catch(err =>
        logger.warn('[AnalysisHandoff] spawnTasks failed', { wuId: wu.id, error: String(err) }),
      );
    }
  }

  /**
   * 等待本实例已触发的全部事件链落定（测试用确定性信号，替代盲等轮询）。
   * publish 在 transitionStatus await 链内同步发射（eventBus emit 同步），故
   * await 触发方返回时在途链必已登记。实现经 studio-shared createSettledTracker。
   */
  async waitForSettled(): Promise<void> {
    await this.settled.waitForSettled();
  }

  private readMeta(wu: WorkUnitData): WorkUnitMetadata {
    return parseWuMetadata(wu.metadata);
  }

  private async post(wu: WorkUnitData, content: string): Promise<void> {
    if (!wu.channelId || !content.trim()) return;
    await this.messageService.createAgentMessage(wu.channelId, 'Studio', content, { workUnitId: wu.id });
  }

  /** 非空 TASK 拆分行（spawnTasks 同口径：空白行不算任务） */
  private taskScopes(meta: WorkUnitMetadata): string[] {
    return Array.isArray(meta.analysisTasks)
      ? meta.analysisTasks.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, ANALYSIS_TASKS_MAX)
      : [];
  }

  /**
   * in_review 路由（#186 / #167 决议，2026-08-16）：
   *   - 有频道：维持确认闸不变——频道发人工确认提示（原行为）。
   *   - 无频道 + trigger 来源 + 无 TASK：免确认直转 done（决议 1）——#130 T8 人闸已在
   *     建单时设过，巡检单无 TASK 下游，第二道闸纯空转。
   *   - 无频道其余情形（trigger 带 TASK / 非 trigger）：保留人闸，确认提示改投
   *     Web「需要处理」收件箱（决议 2，修 channelId=null 早退吞提示的断链）。
   */
  private async handleInReview(wu: WorkUnitData): Promise<void> {
    const meta = this.readMeta(wu);
    if (wu.channelId) {
      await this.postConfirmGuidance(wu);
      return;
    }
    const isTrigger = typeof meta.triggerId === 'string' && meta.triggerId.length > 0;
    if (isTrigger && this.taskScopes(meta).length === 0) {
      await this.autoConfirmTriggerInspection(wu);
      return;
    }
    this.postConfirmGuidanceToInbox(wu, isTrigger);
  }

  /** 决议 1：trigger 巡检单（无频道、无 TASK）免确认直转 done，留痕 autoConfirmed* */
  private async autoConfirmTriggerInspection(wu: WorkUnitData): Promise<void> {
    // 事件载荷可能是旧快照（重发/乱序）——以库存最新状态为准，已离开 in_review 不再动作
    const fresh = await this.workUnitService.getById(wu.id);
    if (!fresh || fresh.status !== 'in_review') return;
    await this.workUnitService.reviewPassed(wu.id);
    await this.fileStore.updateMetadata(wu.id, latest => ({
      ...latest,
      autoConfirmedBy: 'trigger-inspection-no-gate',
      autoConfirmedAt: new Date().toISOString(),
    }));
    logger.info('[AnalysisHandoff] trigger 巡检单免确认直转 done（#167 决议 1）', { wuId: wu.id });
  }

  /** 决议 2：无频道确认提示投 Web「需要处理」收件箱（dispatchMonitorAlerts 既有管线，warning 级） */
  private postConfirmGuidanceToInbox(wu: WorkUnitData, isTrigger: boolean): void {
    const hasTasks = this.taskScopes(this.readMeta(wu)).length > 0;
    dispatchMonitorAlerts([{
      source: 'analysis_confirm',
      level: 'warning',
      relatedTaskIds: [wu.id],
      message: `分析结论待人工确认：「${wu.scope.slice(0, 60)}」（WU ${wu.id.slice(0, 8)}，`
        + `${isTrigger ? 'trigger 自动巡检' : 'analysis'}，无频道可投递）——请在 Web WorkUnit 列表/详情点「通过」`
        + (hasTasks ? '（确认后将按 TASK 拆分自动派工）' : '')
        + '；结论有问题点「拒绝」返工',
    }]);
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
    if (meta.analysisTasksSpawnedAt || meta.analysisTasksSpawned) return;

    const tasks = this.taskScopes(meta);

    // 幂等哨兵先落档：即便后续建单部分失败也不重复派生（差额由 #183 对账扫描补建）。
    // #170 updateMetadata 锁内合并写：与 map-opening 同一 done 事件写同一 WU metadata
    // （它落 mapOpenedAt）不再 read-modify-write 互覆（#115 e2e 实测两哨兵互覆）。
    // #183（#159 决议 2）哨兵清单化：时间戳 + 已建子 WU id 清单（初始空，随建单逐个追加）。
    // stamp 回读比对判定本实例是否抢到哨兵（并发/重发只放行一个）。
    const stamp = new Date().toISOString();
    const sentinel = await this.fileStore.updateMetadata(fresh.id, latest =>
      (latest.analysisTasksSpawnedAt || latest.analysisTasksSpawned)
        ? latest // 重读后哨兵已落（并发/重发）
        : { ...latest, analysisTasksSpawnedAt: stamp, analysisTasksSpawned: [] as string[] });
    if (!sentinel) return;
    if (parseWuMetadata(sentinel.metadata).analysisTasksSpawnedAt !== stamp) return;

    if (tasks.length === 0) {
      await this.post(fresh, '分析结论已确认。未输出 TASK 拆分行，不自动派生任务——可在频道里转任务或手动创建 WorkUnit');
      return;
    }

    const created: string[] = [];
    // #177（#69 决议）：analysis 确认处可选「默认执行角色」应用于全部派生 task 子 WU
    // （留空 = 涌现）；指名 = 排他邮箱，无自动回池（滞留由 #62 探针出声）
    const defaultAssigneeId = this.resolveDefaultAssignee(meta);
    for (const scope of tasks) {
      try {
        const child = await this.createTaskChild(fresh, scope, meta, defaultAssigneeId);
        created.push(scope);
        // 清单随建单逐个追加（锁内合并写）；追加失败不阻断——对账扫描的活体去重兜底
        await this.appendSpawnedId(fresh.id, child.id).catch(err =>
          logger.warn('[AnalysisHandoff] append spawned id failed (对账将认养补记)', { wuId: fresh.id, childId: child.id, error: String(err) }),
        );
      } catch (err) {
        logger.warn('[AnalysisHandoff] create task WU failed (skip, 对账将补建)', { wuId: fresh.id, scope: scope.slice(0, 80), error: String(err) });
      }
    }

    logger.info('[AnalysisHandoff] Spawned task WUs from analysis', { wuId: fresh.id, count: created.length });
    if (created.length > 0) {
      await this.post(
        fresh,
        `分析结论已确认，拆分 ${created.length} 个任务并派工（${defaultAssigneeId ? '已指定执行角色' : '频道成员自动认领'}）：\n`
        + created.map((t, i) => `${i + 1}. ${t}`).join('\n'),
      );
    }
  }

  /** #177 默认执行角色解析（spawnTasks 与对账补建共用） */
  private resolveDefaultAssignee(meta: WorkUnitMetadata): string | null {
    return typeof meta.defaultTaskAssigneeId === 'string' && meta.defaultTaskAssigneeId.trim()
      ? meta.defaultTaskAssigneeId.trim()
      : null;
  }

  /** 建单个派生 task 子 WU（spawnTasks 与 #183 对账补建共用同一形状） */
  private async createTaskChild(
    fresh: WorkUnitData,
    scope: string,
    meta: WorkUnitMetadata,
    defaultAssigneeId: string | null,
  ): Promise<WorkUnitData> {
    return this.workUnitService.create({
      type: 'task',
      scope,
      status: 'unassigned',
      ...(defaultAssigneeId ? { assigneeId: defaultAssigneeId } : {}),
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
  }

  /** 清单追加子 WU id（锁内合并写；幂等——已在清单不重复追加） */
  private async appendSpawnedId(wuId: string, childId: string): Promise<void> {
    await this.fileStore.updateMetadata(wuId, latest => {
      const list = Array.isArray(latest.analysisTasksSpawned) ? latest.analysisTasksSpawned as string[] : [];
      if (list.includes(childId)) return latest;
      return { ...latest, analysisTasksSpawned: [...list, childId] };
    });
  }

  /**
   * #183（#159 决议 2/3）对账差集：analysisTasks 中未被清单覆盖的 scope。
   * 口径以 id 清单为准——人工关闭的子 WU 仍在清单中（closed 不删 index）→ 覆盖、不复活；
   * 清单 id 已从 index 消失（硬删除墓碑）→ 不覆盖，进差集补建。
   */
  async listMissingSpawnScopes(wu: WorkUnitData): Promise<string[]> {
    const meta = this.readMeta(wu);
    const tasks = this.taskScopes(meta);
    const spawned = Array.isArray(meta.analysisTasksSpawned) ? meta.analysisTasksSpawned : [];

    // 清单 id → scope 多重集（同 scope 多条时按个数抵扣）
    const covered = new Map<string, number>();
    for (const id of spawned) {
      const child = await this.workUnitService.getById(id).catch(() => null);
      if (!child) continue;
      covered.set(child.scope, (covered.get(child.scope) ?? 0) + 1);
    }
    const missing: string[] = [];
    for (const scope of tasks) {
      const n = covered.get(scope) ?? 0;
      if (n > 0) covered.set(scope, n - 1);
      else missing.push(scope);
    }
    return missing;
  }

  /**
   * #183（#159 决议 2）对账补建：补差集前按 parentId+scope 查活体去重
   * （create 成功但清单落档失败的极端窗口 → 认养入清单，不重复建单）。
   * 频道不出声（决议 5）；出声由对账扫描方统一走 #62 告警管线。
   */
  async respawnScopes(
    wu: WorkUnitData,
    scopes: string[],
  ): Promise<{ createdIds: string[]; adoptedIds: string[]; failedScopes: string[] }> {
    const result = { createdIds: [] as string[], adoptedIds: [] as string[], failedScopes: [] as string[] };
    const fresh = await this.workUnitService.getById(wu.id);
    if (!fresh) return result;
    const meta = this.readMeta(fresh);
    const defaultAssigneeId = this.resolveDefaultAssignee(meta);
    const siblings = (await this.workUnitService.list({ parentId: fresh.id, limit: 1000 })).data;

    for (const scope of scopes) {
      try {
        // 活体去重：同 parentId+scope 且未关闭的子 WU 已存在 → 认养（不重建）
        const live = siblings.find(s => s.scope === scope && s.status !== 'closed');
        if (live) {
          await this.appendSpawnedId(fresh.id, live.id);
          result.adoptedIds.push(live.id);
          continue;
        }
        const child = await this.createTaskChild(fresh, scope, meta, defaultAssigneeId);
        await this.appendSpawnedId(fresh.id, child.id);
        result.createdIds.push(child.id);
        siblings.push(child); // 同轮后续同 scope 去重
      } catch (err) {
        logger.warn('[AnalysisHandoff] reconcile respawn failed', { wuId: fresh.id, scope: scope.slice(0, 80), error: String(err) });
        result.failedScopes.push(scope);
      }
    }
    return result;
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
