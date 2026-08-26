/**
 * Map Opening — 开图机制（#112，#106 子票 T6）
 *
 * 订阅 workunit.status_changed，把 PMO 分析单的人工确认与探路地图（#107 map）接通：
 *   analysis WU → done（人工确认通过）且确认文本含待决问题清单 →
 *   初始化 map（destination + fog[]）→ 逐条建未指派 decision 单 → 回写 fog[].wuId（互挂）。
 *
 * 待决问题清单提取契约（机制只搬运人填文本，不做 LLM 提取）：
 *   来源 = analysis WU 人工确认台账 attestations.l3.summary（reviewPassed 的
 *   可选 body.summary，#110 已穿透端点入参）。逐行约定格式（兼容中文冒号）：
 *     DESTINATION: <目的地>   —— 首条生效；缺省回退项目 title
 *     FOG: <待决问题>         —— 每行一条 fog 条目（上限 MAP_OPENING_FOG_MAX 条）
 *   无 FOG 行 = 无待决问题清单 → 不炸、不初始化、不落哨兵（F6-b 人工补确认会重发
 *   status_changed(done)，后续补填清单仍可开图）。
 *
 * 互挂契约：decision 单 metadata 落 pmoId/pmoNumber/fogId（#110 decision-resolution
 * 按此消费：decision 确认 → 写 map.decisions[] + 消解 fog），fog[].wuId 回写新建 WU id。
 *
 * 幂等：metadata.mapOpenedAt 哨兵（照 analysisTasksSpawnedAt 先例先落档再建单，
 * 建单失败只记日志人工可补）；已有 map 的 PMO 不重建。同 PMO 的 map 写按 projectId
 * 串行化（照 decision-resolution / progress-rollup）。
 *
 * 非探路型（无 FOG 清单）与无 pmoId 的 analysis 不受影响。事件订阅语义与
 * AnalysisHandoff 一致（eventBus 进程内，best-effort）。
 */

import { eventBus, logger, createSettledTracker, type FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitData, type WorkUnitMetadata } from '../workunit/workunit.service.js';
import { parseWuMetadata } from '../workunit/wu-metadata.js';
import { ChannelMessageService } from '../channels/channel-message.service.js';
import { projectService, type PmoMap, type ProjectData } from './project.service.js';

/** 开图 fog 条数上限（照 ANALYSIS_TASKS_MAX 先例防刷屏） */
export const MAP_OPENING_FOG_MAX = 12;

/**
 * 从人工确认文本提取开图要素。逐行解析，兼容中英文冒号；
 * 非约定行原样忽略（确认文本可同时写其他结论）。
 */
export function parseMapOpening(summary: string): { destination?: string; fog: string[] } {
  let destination: string | undefined;
  const fog: string[] = [];
  for (const line of summary.split('\n')) {
    const m = line.match(/^\s*(DESTINATION|FOG)\s*[:：]\s*(.+?)\s*$/i);
    if (!m) continue;
    const [, key, value] = m;
    if (!value) continue;
    if (key.toUpperCase() === 'DESTINATION') {
      if (destination === undefined) destination = value;
    } else if (fog.length < MAP_OPENING_FOG_MAX) {
      fog.push(value);
    }
  }
  return { destination, fog };
}

export class MapOpening {
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
      if (!wu || wu.type !== 'analysis' || wu.status !== 'done') return;
      this.settled.track(this.onAnalysisDone(wu.id).catch(err =>
        logger.warn('[MapOpening] onAnalysisDone failed', { wuId: wu.id, error: String(err) }),
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

  private async onAnalysisDone(wuId: string): Promise<void> {
    // 事件载荷可能是旧快照（重发/乱序）——以库存最新状态为准（同 analysis-handoff）
    const fresh = await this.workUnitService.getById(wuId);
    if (!fresh) return;
    const meta = parseWuMetadata(fresh.metadata);
    // 幂等哨兵：已开图不重复初始化/建单
    if (meta.mapOpenedAt) return;
    const pmoId = typeof meta.pmoId === 'string' ? meta.pmoId : '';
    if (!pmoId) return; // 非 PMO analysis

    const { destination, fog } = parseMapOpening(meta.attestations?.l3?.summary ?? '');
    // 无待决问题清单：不炸、不初始化、不落哨兵（后续人工补确认补填仍可开图，见文件头）
    if (fog.length === 0) return;

    await this.enqueue(pmoId, () => this.openMap(pmoId, destination, fog, fresh, meta));
  }

  /** 同 PMO 的 map 写串行化（照 decision-resolution 链式排队，前序失败不阻断后续） */
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

  private async openMap(
    projectId: string,
    destination: string | undefined,
    questions: string[],
    wu: WorkUnitData,
    meta: WorkUnitMetadata,
  ): Promise<void> {
    const project = await projectService.get(projectId);
    if (!project) return;
    if (project.map) return; // 已有 map 的 PMO：不重建

    // 幂等哨兵先落档：即便后续建单部分失败也不重复派生（失败只记日志，人工可补）。
    // 与 analysis-handoff 同一 done 事件写同一 WU metadata（它落 analysisTasksSpawnedAt）——
    // 写入前重读合并，防 read-modify-write 丢更新（#115 e2e 实测两哨兵互覆）
    const latest = await this.workUnitService.getById(wu.id);
    const latestMeta = latest ? parseWuMetadata(latest.metadata) : meta;
    if (latestMeta.mapOpenedAt) return; // 重读后哨兵已落（并发/重发）
    await this.workUnitService.update(wu.id, {
      metadata: { ...latestMeta, mapOpenedAt: new Date().toISOString() },
    });

    // 1) 先初始化 map（wuId 待回写）
    const map: PmoMap = {
      destination: destination ?? project.title,
      decisions: [],
      fog: questions.map((question, i) => ({ id: `fog-${i + 1}`, question, wuId: null, status: 'open' as const })),
    };
    await projectService.update(projectId, { map });

    // 2) 逐条建未指派 decision 单（频道成员 loop 认领 = 认领该待决问题）
    for (const fogItem of map.fog) {
      try {
        const decision = await this.workUnitService.create({
          type: 'decision',
          scope: `待决问题 ${project.pmoNumber}: ${fogItem.question}`,
          status: 'unassigned',
          channelId: wu.channelId,
          metadata: {
            creationMode: 'map-opening',
            // #110 decision-resolution 消费契约：按 pmoId 找 PMO、按 fogId 定位 fog 条目
            pmoId: project.id,
            pmoNumber: project.pmoNumber,
            fogId: fogItem.id,
          },
        });
        fogItem.wuId = decision.id;
      } catch (err) {
        // 哨兵已落档：建单失败不重复派生，wuId 留 null（未认领），人工可补
        logger.warn('[MapOpening] create decision WU failed (skip)', { wuId: wu.id, projectId, fogId: fogItem.id, error: String(err) });
      }
    }

    // 3) 回写 fog[].wuId（互挂）
    await projectService.update(projectId, { map });

    logger.info('[MapOpening] Map opened', { wuId: wu.id, projectId, fogCount: map.fog.length });
    await this.postOpened(wu, project, map);
  }

  /** 频道发开图结果（best-effort） */
  private async postOpened(wu: WorkUnitData, project: ProjectData, map: PmoMap): Promise<void> {
    if (!wu.channelId) return;
    const lines = map.fog.map((f, i) => `${i + 1}. ${f.question}${f.wuId ? '' : '（建单失败，待人工补）'}`);
    await this.messageService.createAgentMessage(
      wu.channelId,
      'Studio',
      `分析确认通过，已开图 ${project.pmoNumber}（目的地：${map.destination}），`
      + `逐条建成 ${map.fog.length} 个待决问题单（频道成员自动认领）：\n${lines.join('\n')}`,
      { workUnitId: wu.id },
    ).catch(err =>
      logger.warn('[MapOpening] postOpened failed (non-blocking)', { wuId: wu.id, error: String(err) }),
    );
  }
}

// 单例（懒初始化，形态同 DecisionResolution）
let _mapOpening: MapOpening | null = null;

export function initMapOpening(fileStore?: FileStore): MapOpening {
  if (!_mapOpening) {
    const { FileStore } = require('@dommaker/studio-shared') as typeof import('@dommaker/studio-shared');
    const { WorkUnitService } = require('../workunit/workunit.service.js') as typeof import('../workunit/workunit.service.js');
    const fs = fileStore ?? new FileStore();
    _mapOpening = new MapOpening(fs, new WorkUnitService(fs));
  }
  _mapOpening.subscribeToEvents();
  return _mapOpening;
}
