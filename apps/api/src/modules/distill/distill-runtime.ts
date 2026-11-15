/**
 * distill-runtime (#143) — 蒸馏模块运行时装配（唯一 import knowledge-singletons 的文件）
 *
 * 与 DistillService 分离的原因：service 保持依赖注入纯净（测试用临时目录实例），
 * 本文件负责把共享单例（sharedStore / scheduleVectorDbSync）+ 真实数据区路径接上。
 * 形态同 getSystemExecutor / initWuCompletionExtraction：懒单例 + init 订阅。
 */

import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { sharedStore, scheduleVectorDbSync } from '../knowledge/index.js';
import { resolveStudioEventsFile } from '@dommaker/studio-shared';
import { DistillService } from './distill-service.js';
import { createSkillLanding, createMemoryLanding } from './distill-landings.js';
import { getStore } from '../../core/store.js';
import { logger } from '@dommaker/studio-shared/node';


let _service: DistillService | null = null;

/** 懒单例：知识库 = 统一 ~/.studio/knowledge；运行记录落 ~/.studio/distill/ 数据区 */
export function getDistillService(): DistillService {
  if (!_service) {
    const fileStore = getStore();
    const dataDir = studioPath('distill');
    _service = new DistillService({
      store: sharedStore,
      fileStore,
      dataDir,
      eventsFile: resolveStudioEventsFile(),
      onProductsSaved: () => scheduleVectorDbSync(),
      // #145 产物落地通道（skill 提案 / 角色记忆草稿）；constraint 通道已随 #625 拆除
      landings: {
        skill: createSkillLanding({ fileStore, companiesDir: studioPath('data', 'companies') }),
        memory: createMemoryLanding({ fileStore }),
      },
    });
  }
  return _service;
}

/** 启动接线：订阅即时触发，并从 runs.jsonl 恢复未完成 run 与重试定时器。 */
export function initDistillLoop(): DistillService {
  const service = getDistillService();
  service.subscribeToEvents();
  void service.recoverPendingRuns().catch(err =>
    logger.warn('[Distill] startup recovery failed', { error: String(err) }),
  );
  return service;
}
