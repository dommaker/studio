/**
 * 认领段（#668 自 agent-loop.ts 抽出，行为一字不改）：
 * claimAndAnnounce（#175/#55 决策 1 认领即发声，#445 委托 workunit/claim-announce 原语）+
 * 决策 14 认领前适任判断链（ensureClaimFit → recordClaimUnfit 落档 unfitRoles →
 * blockIfAllMembersUnfit 全员不适任转 blocked 人工）。
 * 全部共享状态经 AgentLoopHost 读写；本类零自有状态。
 */
import { parseChannels, logger } from '@dommaker/studio-shared';
import {
  claimWorkUnitAndAnnounce, parseWuMetadata, withBlockedCta,
  type WorkUnitData,
} from '../workunit/index.js';
import { isSystemRole } from '../../core/system-role.js';
import { writeStudioEvent } from '../../utils/studio-events.js';
import { getErrorMessage } from '../../utils/errors.js';
import { judgeClaimFitness, parseUnfitRoles } from './claim-fitness.js';
import type { AgentLoopHost } from './loop-host.js';

export class LoopClaim {
  constructor(private readonly host: AgentLoopHost) {}

  /**
   * #175（#55 决策 1）：认领即发声 —— 每次成功认领在 WU 线程发一条普通系统消息
   * （「『角色名』已认领任务，开始执行」）；超时释放（timeout-release unclaim → unassigned）
   * 后的再认领走同一路径同样发声，与「已释放回池」消息配对成完整叙事。
   * 系统通知待遇：不过 §4.2 发言层新鲜度检查、不带里程碑 meta；
   * 发帖失败只记日志，绝不阻断认领后的执行。
   * #445（spec #441）：原语提升为 workunit/claim-announce（REST claim 端点同路径），
   * 本方法仅为 loop 语义的薄封装（失败 → false 走重试）。
   * @returns 认领是否成功（竞争失败 → false，调用方走重试）
   */
  async claimAndAnnounce(workUnit: WorkUnitData): Promise<boolean> {
    const host = this.host;
    try {
      await claimWorkUnitAndAnnounce(workUnit.id, host.instance!.id, host.role.name, {
        wuService: host.workUnitService,
        fileStore: host.fileStore,
      });
    } catch {
      return false;
    }
    return true;
  }

  /**
   * 决策 14 认领前适任判断（agents/loop/claim-fitness.ts）。
   * 显式指名（assigneeId=profile id，人已点名）不判直接放行；涌现认领才判。
   * 判 no → recordClaimUnfit 落档 unfitRoles（含全员不适任转 blocked 检查）→ false。
   * 判断本身从宽（judgeClaimFitness 内部全 catch）；落档失败同口径从宽放行——
   * 宁可误抢（NEED_INPUT 兜底）也不可因 FileStore 抖动每轮空烧判断调用。
   */
  async ensureClaimFit(wu: WorkUnitData): Promise<boolean> {
    const host = this.host;
    if (wu.assigneeId) return true;
    // 2026-09-25 判定台账：计时 + 结构化事件（agent:claim_fitness）落 studio-events.jsonl，
    // 作为后续优化（生产侧路由/单候选豁免/轻模型）的数据源——判定频次、判 no 率、
    // 时延分布、按角色/wu.type 切片均可离线对齐。fire-and-forget，不写失败不阻断认领。
    const judgeStartedAt = Date.now();
    const verdict = await judgeClaimFitness(wu, host.role);
    void writeStudioEvent('agent:claim_fitness', {
      wuId: wu.id,
      roleId: host.role.id,
      instanceId: host.instance?.id ?? null,
      channelId: wu.channelId ?? null,
      wuType: wu.type,
      fit: verdict.fit,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      durationMs: Date.now() - judgeStartedAt,
    }, { source: 'claim-fitness' }).catch(() => {});
    if (verdict.fit) return true;
    try {
      await this.recordClaimUnfit(wu, verdict.reason);
    } catch (err) {
      logger.warn(`[AgentLoop] record unfitRoles failed — 从宽放行认领: ${getErrorMessage(err)}`, { wuId: wu.id });
      return true;
    }
    return false;
  }

  /**
   * 不适任落档：读-改-写合并最新 metadata 追加 unfitRoles 条目
   * （读-改-写互覆防护同 completion-extraction 哨兵先例）。WU 已非 unassigned
   * （他角色抢先认领）→ 不落档。落档后检查全员不适任 → 转 blocked 转人工。
   */
  private async recordClaimUnfit(wu: WorkUnitData, reason: string): Promise<void> {
    const host = this.host;
    const fresh = await host.workUnitService.getById(wu.id);
    if (!fresh || fresh.status !== 'unassigned') return;
    const unfitRoles = [
      ...parseUnfitRoles(fresh.metadata).filter(e => e.roleId !== host.role.id),
      { roleId: host.role.id, reason, at: new Date().toISOString() },
    ];
    await host.workUnitService.update(fresh.id, {
      metadata: { ...parseWuMetadata(fresh.metadata), unfitRoles },
    });
    logger.info(`[AgentLoop] ${host.role.name} 认领前适任判断 = 不适任，已落档 unfitRoles`, {
      wuId: fresh.id, reason,
    });
    await this.blockIfAllMembersUnfit(fresh.id, unfitRoles);
  }

  /**
   * 全员不适任转人工：unfitRoles 覆盖该频道全部 active 成员（口径同
   * review-dispatcher.getChannelActiveMembers：channel.members ∩ active profile，排除 studio）
   * → WU 置 blocked + blockReason 落档 + 频道消息「无人能接」（仿现有 blocked 转人模式：
   * withBlockedCta + 里程碑）。成员未知（历史频道未回填）/ 无频道 → 不判，保持涌现等待。
   * 各步失败只记日志，不抛（调用方本轮已放弃认领，WU 保持 unassigned 等下轮/人工）。
   */
  private async blockIfAllMembersUnfit(wuId: string, unfitRoles: { roleId: string }[]): Promise<void> {
    const host = this.host;
    try {
      const wu = await host.workUnitService.getById(wuId);
      if (!wu?.channelId) return;
      const channel = await host.fileStore.getChannel(wu.channelId);
      const memberIds = parseChannels(channel?.members);
      if (memberIds.length === 0) return;
      const activeMembers = (await host.fileStore.listProfiles({ status: 'active' }))
        .filter(p => memberIds.includes(p.id) && !isSystemRole(p));
      if (activeMembers.length === 0) return;
      const unfitIds = new Set(unfitRoles.map(e => e.roleId));
      if (!activeMembers.every(p => unfitIds.has(p.id))) return;

      const blockReason = `unfit-all: 频道 ${activeMembers.length} 个 active 角色认领前适任判断均为不适任`;
      // unassigned → blocked 不在 VALID_TRANSITIONS，走语义方法直写（blockForManualRelease 先例）；
      // 返回 null = 已非 unassigned（他角色抢先认领/状态迁移），不再转人工
      const blocked = await host.workUnitService.blockForAllUnfit(wuId, blockReason);
      if (!blocked) return;
      logger.warn(`[AgentLoop] 全员不适任，WU 转 blocked 待人工`, { wuId, blockReason });
      await host.postToDiscussionSpace(
        wuId,
        withBlockedCta('频道内无人能接此任务，已转 blocked 等待人工介入', blockReason),
        blocked,
      );
    } catch (err) {
      logger.warn(`[AgentLoop] blockIfAllMembersUnfit failed (non-blocking): ${getErrorMessage(err)}`, { wuId });
    }
  }
}
