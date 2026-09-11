/**
 * REQ 状态汇总（vision §5.3）：订阅 workunit.status_changed，
 * 一个需求的全部 WorkUnit 到达终态 → Requirement status = done。
 * best-effort：汇总失败仅记日志。
 *
 * #457（perf，架构评审第四轮候选 9）：消费侧改 per-req 聚合 memo + 去抖合并
 * （照 #410 pmo/progress-rollup 已验证先例，非新抽象），消除每事件全量索引读
 * （原 maybeRollUpToDone 内部 getIndex() 全量 + reqId 过滤）：
 *   - memo 按 reqId 维护兄弟 WU 的归约输入最小字段集（id/status/reqId），
 *     事件负载（snapshotToData 全量快照）直接喂入，稳态零存储读；
 *   - workunit.created 只喂 memo 不触发评估（与原实现一致——created 本就不汇总），
 *     感知「created 直落非终态、无 status_changed」的新增 WU（原实现靠评估时
 *     全量读看见它们，memo 口径需显式记账对齐）；
 *   - 冷启动（memo 未回源）首个评估经 svc.listWorkUnitSnapshots 回源一次补齐
 *     兄弟 WU；持久化先于 publish（workunit.service persistSnapshot），事件喂入
 *     的状态恒 ≥ 存储任一更早读取——回源只补 memo 缺失的 wu，不覆盖事件喂入项；
 *   - 归属迁移（事件负载 reqId 与 memo 记账不符）时从旧 memo 移除，单 WU 不双计；
 *   - 同 req 去抖窗口（rollupTiming.debounceMs，默认 50ms）内连续事件合并为
 *     一次评估；评估本身仍走 svc.maybeRollUpToDone——Requirement 状态判定
 *     （done/archived/别名跳过）内部恒新鲜 get，行为口径与原实现逐点一致；
 *   - 已知接受项（同 #410）：WU delete 无事件，memo 可能留住已删非终态 WU 导致
 *     该 req 不再自动汇总；直调 svc.maybeRollUpToDone（无快照参）恒回源可纠偏。
 */
import { eventBus, logger, createSettledTracker } from '@dommaker/studio-shared';
import { RequirementService, type ReqRollupSnapshot } from './requirement.service.js';

/** status_changed / created 事件负载中 rollup 消费的最小字段集（snapshotToData 全量数据的子集） */
interface WuRollupEventData {
  id: string;
  status: string;
  reqId?: string | null;
}

/** per-req 兄弟 WU 归约输入聚合（稳态不再回读存储） */
interface ReqRollupMemo {
  wus: Map<string, ReqRollupSnapshot>;
  /** true = 只有事件记账、尚未回源构建（首个评估时回源一次补齐兄弟 WU） */
  cold: boolean;
}

/** #457 去抖窗口：同 req 窗口内连续事件合并为一次评估（测试可调整以锁定合并行为，生产恒用默认 50ms） */
export const rollupTiming = { debounceMs: 50 };

/**
 * 测试可观测性（同 #410 rollupTracker）：事件订阅是 fire-and-forget，handler 在
 * publish 同步链内登记评估 promise（贯穿去抖窗口），waitForSettled 返回时
 * 挂起的去抖评估同样已落定。
 */
const rollupTracker = createSettledTracker();

/** 等待当前已触发的全部汇总评估落定（测试用确定性信号，替代盲等轮询） */
export async function waitForRequirementRollupSettled(): Promise<void> {
  await rollupTracker.waitForSettled();
}

/**
 * 挂载汇总订阅，返回解绑函数（测试用）。
 * 生产环境在 API 启动时调用一次（见 apps/api/src/index.ts）。
 * memo/归属/去抖状态按挂载闭包隔离（测试多次挂载互不串扰；生产单存储单挂载）。
 */
export function initRequirementRollup(service?: RequirementService): () => void {
  const svc = service ?? new RequirementService();
  const memos = new Map<string, ReqRollupMemo>();
  /** wuId → 当前归属 req（归属迁移时从旧 memo 移除，单 WU 不双计） */
  const wuReq = new Map<string, string>();
  const scheduled = new Map<string, Promise<void>>();

  /** 事件负载喂 memo（status_changed 与 created 共用）。返回归属 reqId（无归属 = 不触发） */
  function attachEventWu(wu: WuRollupEventData): string | null {
    const reqId = wu.reqId ?? null;
    const prev = wuReq.get(wu.id);
    if (prev && prev !== reqId) {
      memos.get(prev)?.wus.delete(wu.id);
      wuReq.delete(wu.id);
    }
    if (!reqId) return null;
    let memo = memos.get(reqId);
    if (!memo) {
      memo = { wus: new Map<string, ReqRollupSnapshot>(), cold: true };
      memos.set(reqId, memo);
    }
    memo.wus.set(wu.id, { id: wu.id, status: wu.status, reqId });
    wuReq.set(wu.id, reqId);
    return reqId;
  }

  /** 冷启动回源：只补 memo 缺失的兄弟 WU，不覆盖事件喂入项（事件状态恒 ≥ 存储更早读取，见文件头） */
  async function resourceMemo(reqId: string, memo: ReqRollupMemo): Promise<void> {
    const snapshots = await svc.listWorkUnitSnapshots(reqId);
    for (const s of snapshots) {
      if (memo.wus.has(s.id)) continue;
      const bound = wuReq.get(s.id);
      if (bound && bound !== reqId) continue; // 回源途中已迁出（事件先行记账到别的 req），不抢回
      memo.wus.set(s.id, { id: s.id, status: s.status, reqId });
      wuReq.set(s.id, reqId);
    }
    memo.cold = false;
  }

  async function evaluate(reqId: string): Promise<void> {
    const memo = memos.get(reqId);
    if (!memo) return;
    if (memo.cold) await resourceMemo(reqId, memo);
    await svc.maybeRollUpToDone(reqId, [...memo.wus.values()]);
  }

  /** 去抖调度：窗口内已有挂起评估则复用（挂起的评估吃到 memo 最新态，后到事件只需喂 memo） */
  function scheduleEvaluation(reqId: string): Promise<void> {
    const pending = scheduled.get(reqId);
    if (pending) return pending;
    const p = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        scheduled.delete(reqId);
        evaluate(reqId).then(resolve, reject);
      }, rollupTiming.debounceMs);
      timer.unref?.(); // best-effort 汇总不吊住进程退出
    });
    scheduled.set(reqId, p);
    return p;
  }

  const statusHandler = (payload: { workunit?: WuRollupEventData }) => {
    const wu = payload?.workunit;
    if (!wu) return;
    const reqId = attachEventWu(wu);
    if (!reqId) return;
    rollupTracker.track(scheduleEvaluation(reqId).catch(err =>
      logger.warn('[Requirement] Rollup failed (non-blocking)', { reqId, error: String(err) })
    ));
  };
  // created 只喂 memo 不触发评估（与原实现一致），感知无 status_changed 的新增 WU
  const createdHandler = (payload: { workunit?: WuRollupEventData }) => {
    const wu = payload?.workunit;
    if (!wu) return;
    attachEventWu(wu);
  };
  eventBus.subscribe('workunit.status_changed', statusHandler);
  eventBus.subscribe('workunit.created', createdHandler);
  return () => {
    eventBus.unsubscribe('workunit.status_changed', statusHandler);
    eventBus.unsubscribe('workunit.created', createdHandler);
  };
}
