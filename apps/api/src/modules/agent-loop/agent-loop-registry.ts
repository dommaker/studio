// AgentLoopRegistry — profileId → running AgentLoop (F1: AgentLoop 动态挂载)
//
// 挂载/卸载由 AgentProfile 生命周期事件驱动（agent-profile.created/updated/deleted），
// API 启动时批量挂载 active profile 也走同一入口。
// mount 幂等且绝不抛错：单个 profile 的 loop 启动失败不影响其他 profile（失败记录见 F2）。

import { eventBus, logger, FileStore, type AgentProfileData } from '@dommaker/studio-shared';
import { AgentLoop } from './agent-loop.js';
import { getErrorMessage } from '../../utils/errors.js';
import { getStore } from '../../core/store.js';


export interface MountedLoop {
  profileId: string;
  loop: AgentLoop | null;
  status: 'running' | 'failed' | 'skipped';
  error?: string;
}

export class AgentLoopRegistry {
  private loops = new Map<string, MountedLoop>();
  private fileStore?: FileStore;
  private subscribed = false;
  /** #634: per-profile 重挂串行链——连续多次 provider 变更各自触发完整重挂、依次排队 */
  private remountChains = new Map<string, Promise<void>>();

  constructor(fileStore?: FileStore) {
    this.fileStore = fileStore;
  }

  /** Mount an AgentLoop for the profile. Idempotent; never throws. */
  async mount(profile: AgentProfileData): Promise<MountedLoop> {
    const existing = this.loops.get(profile.id);
    if (existing) return existing;

    // 2026-09-10 设计修正：AC-1.3「studio 角色不 mount」已废除——studio 转为系统维护
    // WU 的执行角色（trigger assigneeRole 指名语义 = 独占认领，无 loop 即结构性死单，
    // 见 docs/issues/2026-08-03-unattended-token-burn.md 与 trigger-assignee-check.ts）。
    // studio 的 systemExecutor 直调身份不受影响（读 profile.provider，不经过 loop）。

    const loop = new AgentLoop(profile, this.fileStore);
    let entry: MountedLoop;
    try {
      const started = await loop.start();
      entry = started
        ? { profileId: profile.id, loop, status: 'running' }
        // start() 已把失败原因写入 runtime state（F2），这里只在 registry 标记
        : { profileId: profile.id, loop, status: 'failed', error: 'startup failed (see runtime state lastError)' };
    } catch (err) {
      const message = getErrorMessage(err);
      logger.error(`[AgentLoopRegistry] Mount failed for ${profile.name}: ${message}`);
      entry = { profileId: profile.id, loop, status: 'failed', error: message };
    }
    this.loops.set(profile.id, entry);
    if (entry.status === 'failed') {
      logger.warn(`[AgentLoopRegistry] Loop for profile ${profile.name} marked failed: ${entry.error}`);
    } else {
      logger.info(`[AgentLoopRegistry] Mounted loop for profile ${profile.name}`);
    }
    return entry;
  }

  /** Unmount: stop the loop (if any) and forget the entry. Idempotent. */
  unmount(profileId: string): void {
    const entry = this.loops.get(profileId);
    if (!entry) return;
    try {
      entry.loop?.stop();
    } catch (err) {
      logger.warn(`[AgentLoopRegistry] Stop failed for ${profileId}: ${getErrorMessage(err)}`);
    }
    this.loops.delete(profileId);
    logger.info(`[AgentLoopRegistry] Unmounted loop for profile ${profileId}`);
  }

  get(profileId: string): MountedLoop | undefined {
    return this.loops.get(profileId);
  }

  list(): MountedLoop[] {
    return [...this.loops.values()];
  }

  /** Stop and remove all loops (API shutdown). */
  unmountAll(): void {
    for (const profileId of [...this.loops.keys()]) {
      this.unmount(profileId);
    }
  }

  /** Subscribe to AgentProfile lifecycle events (idempotent). Called once at API boot. */
  subscribeToEvents(): void {
    if (this.subscribed) return;
    this.subscribed = true;

    eventBus.subscribe('agent-profile.created', (payload: { profile: AgentProfileData }) => {
      if (payload?.profile?.status === 'active') {
        this.mount(payload.profile).catch(err =>
          logger.warn(`[AgentLoopRegistry] Auto-mount failed: ${getErrorMessage(err)}`));
      }
    });

    eventBus.subscribe('agent-profile.updated', (payload: { profile: AgentProfileData; previousStatus?: string; changedFields?: string[] }) => {
      const profile = payload?.profile;
      if (!profile) return;
      const prev = payload.previousStatus;
      if (prev !== undefined && prev !== profile.status) {
        // status 迁移（既有行为不变）：激活 → mount；停用 → unmount
        if (profile.status === 'active') {
          this.mount(profile).catch(err =>
            logger.warn(`[AgentLoopRegistry] Auto-mount failed: ${getErrorMessage(err)}`));
        } else {
          this.unmount(profile.id);
        }
        return;
      }
      // #634: active→active 且 provider 实际变更 → 重挂（停旧 loop、等完全退出后以 store 现值重挂）。
      // 触发字段写死 provider 一项——快照中唯一会漂移的可变执行字段；其他字段热更新不在本机制内。
      if (profile.status === 'active' && payload.changedFields?.includes('provider')) {
        this.enqueueRemount(profile.id);
      }
    });

    eventBus.subscribe('agent-profile.deleted', (payload: { profileId: string }) => {
      if (payload?.profileId) this.unmount(payload.profileId);
    });
  }

  /**
   * #634: provider 变更重挂入口——同一 profile 的多次变更串行排队（上一环失败不阻塞后续），
   * 每次重挂在执行时才读 store 现值，不用事件 payload 里的快照值。
   */
  private enqueueRemount(profileId: string): void {
    const prev = this.remountChains.get(profileId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.remountOnce(profileId));
    const tracked = run
      .catch(err => logger.warn(`[AgentLoopRegistry] Remount failed for ${profileId}: ${getErrorMessage(err)}`))
      .finally(() => {
        if (this.remountChains.get(profileId) === tracked) this.remountChains.delete(profileId);
      });
    this.remountChains.set(profileId, tracked);
  }

  /**
   * #634: 单次完整重挂——stop 旧 loop（不杀在飞 step，当前步带旧 provider 跑完）、
   * 等 runLoop 自然退出且 instance terminated 落盘（单活守卫竞态由此串行等待消化），
   * 再以 store 现值挂载新 loop。等待期间角色被删除/停用 → 不重挂。
   * 新 provider 探测失败不回退：落 registry 既有 failed 状态，失败对外可见。
   */
  private async remountOnce(profileId: string): Promise<void> {
    const entry = this.loops.get(profileId);
    if (entry) {
      try {
        entry.loop?.stop();
      } catch (err) {
        logger.warn(`[AgentLoopRegistry] Stop failed for ${profileId}: ${getErrorMessage(err)}`);
      }
      if (entry.loop) await entry.loop.waitForStop();
      this.loops.delete(profileId);
      logger.info(`[AgentLoopRegistry] Unmounted loop for profile ${profileId} (provider remount)`);
    }
    const fresh = await (this.fileStore ?? getStore()).getProfile(profileId);
    if (!fresh || fresh.status !== 'active') return;
    await this.mount(fresh);
  }
}

// 全局单例（与 eventBus 同风格）
export const agentLoopRegistry = new AgentLoopRegistry();
