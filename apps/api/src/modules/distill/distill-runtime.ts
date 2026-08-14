/**
 * distill-runtime (#143) — 蒸馏模块运行时装配（唯一 import knowledge-singletons 的文件）
 *
 * 与 DistillService 分离的原因：service 保持依赖注入纯净（测试用临时目录实例），
 * 本文件负责把共享单例（sharedStore / scheduleVectorDbSync）+ 真实数据区路径接上。
 * 形态同 getSystemExecutor / initWuCompletionExtraction：懒单例 + init 订阅。
 */
import { FileStore } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { sharedStore, scheduleVectorDbSync } from '../knowledge/knowledge-singletons.js';
import { resolveStudioEventsFile } from '../../utils/studio-events.js';
import { DistillService } from './distill-service.js';

let _service: DistillService | null = null;

/** 懒单例：知识库 = 统一 ~/.studio/knowledge；运行记录落 ~/.studio/distill/ 数据区 */
export function getDistillService(): DistillService {
  if (!_service) {
    _service = new DistillService({
      store: sharedStore,
      fileStore: new FileStore(),
      dataDir: studioPath('distill'),
      eventsFile: resolveStudioEventsFile(),
      onProductsSaved: () => scheduleVectorDbSync(),
    });
  }
  return _service;
}

/** 启动接线（index.ts）：单例 + 订阅 workunit.status_changed → done */
export function initDistillLoop(): DistillService {
  const service = getDistillService();
  service.subscribeToEvents();
  return service;
}
