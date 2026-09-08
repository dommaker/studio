/**
 * #445（spec #441 情境引导 04）：「认领即发声」原语 —— 自 agent-loop 私有方法
 * claimAndAnnounce（#175，#55 决策 1）提升为可复用实现，两条入口走同一路径：
 *   - agent loop 自动认领（涌现）：AgentLoop.claimAndAnnounce 委托本模块；
 *   - REST claim 端点（人工经引导片认领）：workunit.routes POST /:id/claim 调本模块。
 * 行为契约（与 #175 决策一致）：认领成功 → WU 线程发一条普通系统消息
 * 「『认领方名』已认领任务，开始执行」（不过发言层新鲜度检查、不带里程碑 meta）；
 * 发声 best-effort——失败只记日志，绝不阻断认领后的执行/响应。
 */
import { logger, FileStore } from '@dommaker/studio-shared';
import type { WorkUnitService, WorkUnitData } from './workunit.service.js';
import { postWuSystemMessage } from './wu-messenger.js';
import { getErrorMessage } from '../../utils/errors.js';

export interface ClaimAndAnnounceDeps {
  wuService: WorkUnitService;
  /** 测试注入；缺省 new FileStore() */
  fileStore?: FileStore;
}

/**
 * 认领即发声。claim 失败（竞争 'Claim failed' / 'File conflict' / 'not found'）原样抛出，
 * 由调用方决定语义（loop → false 走重试；REST → 409/500 错误信封）。
 * @returns 认领后的 WU（active + assigneeId + 新租约）
 */
export async function claimWorkUnitAndAnnounce(
  wuId: string,
  claimerId: string,
  claimerName: string,
  deps: ClaimAndAnnounceDeps,
): Promise<WorkUnitData> {
  const wu = await deps.wuService.claim(wuId, claimerId);
  await postWuSystemMessage(wu, `『${claimerName}』已认领任务，开始执行`, {
    agentName: claimerName,
    fileStore: deps.fileStore,
  }).catch(err => logger.warn(`[ClaimAnnounce] Failed to announce claim for ${wuId}: ${getErrorMessage(err)}`));
  return wu;
}
