/**
 * Decision Resolution — 决策落地（#110，#106 子票 T4）
 *
 * 订阅 workunit.status_changed，把探路地图（#107 map）与 decision 单（#108）接通：
 *   1) decision WU → active（被认领进入讨论）：对应 map.fog[] 条目 open → in-discussion
 *      （幂等——仅 open 态翻转，resolved 不回摆；#106 数据模型三态的补齐，评审收尾）。
 *   2) decision WU → done（人工确认通过）：把人工确认时填写的结论文本**原样**追加
 *      map.decisions[]（不做 LLM 摘要提取），对应 map.fog[] 条目置 resolved。
 *      关联契约：decision WU 的 metadata 带 pmoId 与 fogId（T6 开图机制建单时落档）——
 *      按 metadata.pmoId 找 PMO，按 metadata.fogId 定位 fog 条目；缺戳/找不到条目跳过不炸。
 *      结论文本来源 = 人工确认台账 attestations.l3.summary（reviewPassed 的 summary 入参，
 *      F6 台账原有字段，本票只是把 review-passed 端点的可选 body.summary 穿透进去）；
 *      人工未填 → 空串落 decisions[]（不拒写——机制不阻塞雾消解，最小惊讶）。
 *      幂等：decisions[] 按 wuId 去重，同一 decision WU 重复投递不双写。
 *   3) 所属 PMO 的 fog[] 全 resolved → 自动建未指派 spec 成文单
 *      （scope 带 PMO 引用 + metadata.pmoId/pmoNumber 溯源，形态照 analysis-handoff 建单）。
 *      map.specSpawnedAt 为幂等哨兵（照 analysisTasksSpawnedAt 先例，先落档再建单，
 *      建单失败只记日志人工可补）；建成后 map.specWuId 回写溯源。
 *
 * 非探路型 PMO（无 map）不受影响。事件订阅语义与 AnalysisHandoff 一致
 * （eventBus 进程内，best-effort）；同 PMO 的落地按 projectId 串行化（照 progress-rollup，
 * 防相邻 decision 完成事件并发互相覆盖 map 写）。
 */

import { eventBus, logger, type FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitData, type WorkUnitMetadata } from '../workunit/workunit.service.js';
import { parseWuMetadata } from '../workunit/wu-metadata.js';
import { projectService, type ProjectData, type PmoMap } from './project.service.js';

export class DecisionResolution {
  private subscribed = false;

  constructor(
    private fileStore: FileStore,
    private workUnitService: WorkUnitService,
  ) {}

  /** 订阅 workunit.status_changed。幂等。 */
  subscribeToEvents(): void {
    if (this.subscribed) return;
    this.subscribed = true;

    eventBus.subscribe('workunit.status_changed', async (payload: { workunit: WorkUnitData }) => {
      const wu = payload.workunit;
      if (!wu || wu.type !== 'decision') return;
      if (wu.status === 'done') {
        await this.onDecisionDone(wu.id).catch(err =>
          logger.warn('[DecisionResolution] onDecisionDone failed', { wuId: wu.id, error: String(err) }),
        );
      } else if (wu.status === 'active') {
        await this.onDecisionClaimed(wu.id).catch(err =>
          logger.warn('[DecisionResolution] onDecisionClaimed failed', { wuId: wu.id, error: String(err) }),
        );
      }
    });
  }

  /** decision 单被认领 → 对应雾 open → in-discussion（幂等，仅 open 翻转，resolved 不回摆） */
  private async onDecisionClaimed(wuId: string): Promise<void> {
    const fresh = await this.workUnitService.getById(wuId);
    if (!fresh) return;
    const meta = parseWuMetadata(fresh.metadata);
    const pmoId = typeof meta.pmoId === 'string' ? meta.pmoId : '';
    const fogId = typeof meta.fogId === 'string' ? meta.fogId : '';
    if (!pmoId || !fogId) return;

    await this.enqueue(pmoId, async () => {
      const project = await projectService.get(pmoId);
      const map = project?.map;
      if (!project || !map) return;
      const fogItem = map.fog.find(f => f.id === fogId);
      if (!fogItem || fogItem.status !== 'open') return;
      await projectService.update(pmoId, {
        map: { ...map, fog: map.fog.map(f => (f.id === fogId ? { ...f, status: 'in-discussion' } : f)) },
      });
      logger.info('[DecisionResolution] Fog in-discussion (decision claimed)', { wuId, projectId: pmoId, fogId });
    });
  }

  private async onDecisionDone(wuId: string): Promise<void> {
    // 事件载荷可能是旧快照（重发/乱序）——以库存最新状态为准（同 analysis-handoff）
    const fresh = await this.workUnitService.getById(wuId);
    if (!fresh) return;
    const meta = parseWuMetadata(fresh.metadata);
    const pmoId = typeof meta.pmoId === 'string' ? meta.pmoId : '';
    const fogId = typeof meta.fogId === 'string' ? meta.fogId : '';
    // 缺关联戳（非开图机制建的 decision 单）→ 跳过不炸
    if (!pmoId || !fogId) return;

    await this.enqueue(pmoId, () => this.resolve(pmoId, fogId, fresh, meta));
  }

  /** 同 PMO 的 map 写串行化（照 progress-rollup 链式排队，前序失败不阻断后续） */
  private chains = new Map<string, Promise<void>>();

  private enqueue(projectId: string, task: () => Promise<void>): Promise<void> {
    const run = (this.chains.get(projectId) ?? Promise.resolve())
      .catch(() => { /* 前序失败不阻断后续 */ })
      .then(task);
    this.chains.set(projectId, run);
    const cleanup = () => { if (this.chains.get(projectId) === run) this.chains.delete(projectId); };
    run.then(cleanup, cleanup);
    return run;
  }

  private async resolve(projectId: string, fogId: string, wu: WorkUnitData, meta: WorkUnitMetadata): Promise<void> {
    const project = await projectService.get(projectId);
    const map = project?.map;
    if (!project || !map) return; // 非探路型（无 map）不受影响

    // 幂等：同一 decision WU 已落地过（重复投递/乱序重放）不双写
    if (map.decisions.some(d => d.wuId === wu.id)) return;

    const fogItem = map.fog.find(f => f.id === fogId);
    if (!fogItem) {
      logger.warn('[DecisionResolution] fog item not found (skip)', { wuId: wu.id, projectId, fogId });
      return;
    }

    // 结论文本原样落地：人工确认台账 l3.summary；未填 → 空串（不拒写，见文件头）
    const summary = meta.attestations?.l3?.summary ?? '';
    const now = new Date().toISOString();
    const newMap: PmoMap = {
      ...map,
      decisions: [...map.decisions, { wuId: wu.id, summary, resolvedAt: now }],
      fog: map.fog.map(f => (f.id === fogId ? { ...f, status: 'resolved' } : f)),
    };

    // 雾全清 → 派生 spec 成文单。哨兵随本次 map 写先落档（照 analysisTasksSpawnedAt
    // 先例：即便后续建单失败也不重复派生，失败只记日志人工可补）
    const spawnSpec = newMap.fog.every(f => f.status === 'resolved') && !map.specSpawnedAt;
    if (spawnSpec) newMap.specSpawnedAt = now;
    await projectService.update(projectId, { map: newMap });

    logger.info('[DecisionResolution] Decision landed', {
      wuId: wu.id, projectId, fogId, allFogResolved: newMap.fog.every(f => f.status === 'resolved'),
    });

    if (spawnSpec) await this.spawnSpecWu(project, newMap, wu.channelId);
  }

  /** 雾全清后建未指派 spec 成文单（best-effort；哨兵已落档，失败不重复派生） */
  private async spawnSpecWu(project: ProjectData, map: PmoMap, channelId: string | null): Promise<void> {
    try {
      const decisions = map.decisions.map((d, i) => `${i + 1}. ${d.summary || '（未填结论）'}`).join('\n');
      const spec = await this.workUnitService.create({
        type: 'spec',
        scope: `成文 ${project.pmoNumber}: ${project.title}\n\n目的地: ${map.destination}\n\n已落地决策（按序）:\n${decisions}`,
        status: 'unassigned',
        channelId,
        metadata: {
          creationMode: 'fog-cleared',
          // PMO 溯源（progress-rollup / delivery 台账消费，同 analysis-handoff 先例）
          pmoId: project.id,
          pmoNumber: project.pmoNumber,
        },
      });
      // 溯源回写（哨兵是 specSpawnedAt；本写失败不影响幂等，仅少一层溯源）
      await projectService.update(project.id, { map: { ...map, specWuId: spec.id } }).catch(err =>
        logger.warn('[DecisionResolution] specWuId writeback failed (non-blocking)', { projectId: project.id, specWuId: spec.id, error: String(err) }),
      );
      logger.info('[DecisionResolution] Spec WU spawned (all fog resolved)', { projectId: project.id, specWuId: spec.id });
    } catch (err) {
      logger.warn('[DecisionResolution] spawn spec WU failed (skip)', { projectId: project.id, error: String(err) });
    }
  }
}

// 单例（懒初始化，形态同 AnalysisHandoff）
let _decisionResolution: DecisionResolution | null = null;

export function initDecisionResolution(fileStore?: FileStore): DecisionResolution {
  if (!_decisionResolution) {
    const { FileStore } = require('@dommaker/studio-shared') as typeof import('@dommaker/studio-shared');
    const { WorkUnitService } = require('../workunit/workunit.service.js') as typeof import('../workunit/workunit.service.js');
    const fs = fileStore ?? new FileStore();
    _decisionResolution = new DecisionResolution(fs, new WorkUnitService(fs));
  }
  _decisionResolution.subscribeToEvents();
  return _decisionResolution;
}
