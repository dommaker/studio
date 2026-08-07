// AgentLoopRegistry — profileId → running AgentLoop (F1: AgentLoop 动态挂载)
//
// 挂载/卸载由 AgentProfile 生命周期事件驱动（agent-profile.created/updated/deleted），
// API 启动时批量挂载 active profile 也走同一入口。
// mount 幂等且绝不抛错：单个 profile 的 loop 启动失败不影响其他 profile（失败记录见 F2）。

import { eventBus, logger, FileStore, type AgentProfileData } from '@dommaker/studio-shared';
import { AgentLoop } from './agent-loop.js';

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

  constructor(fileStore?: FileStore) {
    this.fileStore = fileStore;
  }

  /** Mount an AgentLoop for the profile. Idempotent; never throws. */
  async mount(profile: AgentProfileData): Promise<MountedLoop> {
    const existing = this.loops.get(profile.id);
    if (existing) return existing;

    // AC-1.3: studio 角色不 mount（系统任务执行身份，不消费 WU，由 systemExecutor 直接 spawn）
    if (profile.name === 'studio') {
      const entry: MountedLoop = {
        profileId: profile.id,
        loop: null,
        status: 'skipped',
        error: 'system role',
      };
      this.loops.set(profile.id, entry);
      logger.info(`[AgentLoopRegistry] Skipped mount for system role ${profile.name}`);
      return entry;
    }

    const loop = new AgentLoop(profile, this.fileStore);
    let entry: MountedLoop;
    try {
      const started = await loop.start();
      entry = started
        ? { profileId: profile.id, loop, status: 'running' }
        // start() 已把失败原因写入 runtime state（F2），这里只在 registry 标记
        : { profileId: profile.id, loop, status: 'failed', error: 'startup failed (see runtime state lastError)' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
      logger.warn(`[AgentLoopRegistry] Stop failed for ${profileId}: ${err instanceof Error ? err.message : String(err)}`);
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
          logger.warn(`[AgentLoopRegistry] Auto-mount failed: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

    eventBus.subscribe('agent-profile.updated', (payload: { profile: AgentProfileData; previousStatus?: string }) => {
      const profile = payload?.profile;
      if (!profile) return;
      if (profile.status === 'active' && payload.previousStatus !== 'active') {
        this.mount(profile).catch(err =>
          logger.warn(`[AgentLoopRegistry] Auto-mount failed: ${err instanceof Error ? err.message : String(err)}`));
      } else if (profile.status !== 'active' && payload.previousStatus === 'active') {
        this.unmount(profile.id);
      }
    });

    eventBus.subscribe('agent-profile.deleted', (payload: { profileId: string }) => {
      if (payload?.profileId) this.unmount(payload.profileId);
    });
  }
}

// 全局单例（与 eventBus 同风格）
export const agentLoopRegistry = new AgentLoopRegistry();
